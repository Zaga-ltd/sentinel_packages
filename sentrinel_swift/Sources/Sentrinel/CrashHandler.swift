// ─── Native crash handlers ──────────────────────────────────────────────────
//
// This is the piece the Flutter SDK cannot reach: a segfault, a Swift trap, an
// ObjC exception that escapes to the runtime. The process is about to die, so
// the report is written to disk immediately and the next launch delivers it.
//
// Two hooks:
//   * `NSSetUncaughtExceptionHandler` — uncaught ObjC exceptions. The previous
//     handler is called afterwards, so another reporter keeps working.
//   * `sigaction` for SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV and SIGTRAP —
//     SIGTRAP is how a Swift trap (force-unwrap of nil, array out of bounds,
//     `fatalError`) arrives on arm64, and missing it missed most Swift crashes.
//
// A signal handler may only call async-signal-safe functions. The old one ran
// JSONEncoder and FileManager — allocation and locks in a process whose heap
// may be the thing that is corrupt, which can deadlock the crash itself. This
// one does nothing but copy bytes into memory allocated at start and call
// `write(2)` on a descriptor opened at start:
//
//   * The record is pre-rendered whenever what it would say changes — user,
//     context, breadcrumbs — into one of two buffers, swapped with a single
//     word store, so the handler never sees a half-written one.
//   * The handler appends only what it learns at crash time: the time (from
//     `clock_gettime`, formatted by arithmetic), the signal name (a static
//     string), and the return addresses (`backtrace`, which walks frame
//     pointers into a preallocated array), then writes the line.
//   * It runs on an alternate stack, so a stack overflow can still be
//     reported (on the thread that installed it — `sigaltstack` is per
//     thread).
//   * Afterwards it restores the previous handler and re-raises, so the
//     system's crash report and any other reporter still see the crash.
//
// An uncaught NSException ends in `abort()`, i.e. SIGABRT. The exception
// handler records it with its name, reason and symbols, and sets a flag the
// SIGABRT handler reads, so one crash is not reported twice.

import Foundation
import Darwin
import MachO

/// How the crash was caught. Mirrors the Flutter SDK's `sentrinel.mechanism`
/// attribute so the Issues page says the same things for both platforms.
enum CrashMechanism {
    static let nsException = "NSSetUncaughtExceptionHandler"
    static let signal = "sigaction"
}

// ── Memory the signal handler touches, allocated once in `prepare` ──────────
//
// File-level globals rather than static members so the `@convention(c)`
// handler can reach them without capturing context. All are raw pointers or
// plain integers: nothing here is reference-counted.

let sentrinelTemplateCapacity = 48 * 1024
let sentrinelScratchCapacity = 64 * 1024
let sentrinelMaxFrames = 64

var sentrinelCrashFd: Int32 = -1
var sentrinelTemplates: UnsafeMutablePointer<UInt8>?
var sentrinelTemplateLengths: UnsafeMutablePointer<Int>?
var sentrinelActiveTemplate: Int = 0
var sentrinelScratch: UnsafeMutablePointer<UInt8>?
var sentrinelFrames: UnsafeMutablePointer<UnsafeMutableRawPointer?>?
var sentrinelPreviousActions: UnsafeMutablePointer<sigaction>?
var sentrinelAltStack: UnsafeMutableRawPointer?
/// Set by the NSException handler; the SIGABRT that follows is the same crash.
var sentrinelExceptionRecorded: Int32 = 0
/// Set on entry to the signal handler; a second signal while writing (or on a
/// second crashing thread) skips straight to the previous handler.
var sentrinelHandling: Int32 = 0
var sentrinelPreviousExceptionHandler: (@convention(c) (NSException) -> Void)?

let sentrinelFatalSignals: [Int32] = [SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP]

final class CrashHandler {
    private static let lock = NSLock()
    private static var prepared = false
    private static var installed = false

    /// Allocate what the handlers need and point them at [fd]. Safe to call
    /// again with a new descriptor (a second `start`).
    static func prepare(fd: Int32) {
        lock.lock()
        defer { lock.unlock() }
        if !prepared {
            sentrinelTemplates = .allocate(capacity: sentrinelTemplateCapacity * 2)
            sentrinelTemplateLengths = .allocate(capacity: 2)
            sentrinelTemplateLengths!.initialize(repeating: 0, count: 2)
            sentrinelScratch = .allocate(capacity: sentrinelScratchCapacity)
            sentrinelFrames = .allocate(capacity: sentrinelMaxFrames)
            sentrinelFrames!.initialize(repeating: nil, count: sentrinelMaxFrames)
            sentrinelPreviousActions = .allocate(capacity: 64)
            sentrinelPreviousActions!.initialize(repeating: sigaction(), count: 64)
            // Touch every global once here, so none is lazily initialised —
            // which takes a lock — for the first time inside a signal handler.
            sentrinelActiveTemplate = 0
            sentrinelExceptionRecorded = 0
            sentrinelHandling = 0
            _ = sentrinelFatalSignals.count
            prepared = true
        }
        sentrinelCrashFd = fd
    }

    /// Replace the pre-rendered record. [prefix] is everything up to and
    /// including `"sentrinel.mechanism":"` — see `Sentrinel.renderCrashPrefix`.
    static func setTemplate(_ prefix: Data) {
        lock.lock()
        defer { lock.unlock() }
        guard let templates = sentrinelTemplates, let lengths = sentrinelTemplateLengths else { return }
        // Leave room for what the handler appends: time, name, frames.
        guard prefix.count <= sentrinelTemplateCapacity,
              prefix.count + 4096 <= sentrinelScratchCapacity
        else { return }
        let next = 1 - sentrinelActiveTemplate
        let target = templates + next * sentrinelTemplateCapacity
        prefix.withUnsafeBytes { raw in
            if let base = raw.baseAddress { memcpy(target, base, raw.count) }
        }
        lengths[next] = prefix.count
        // One word store: a handler reads either the old buffer or the new.
        sentrinelActiveTemplate = next
    }

    /// Install the exception and signal handlers, once per process.
    static func install() {
        lock.lock()
        defer { lock.unlock() }
        guard prepared, !installed else { return }
        installed = true

        sentrinelPreviousExceptionHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { exception in
            sentrinelWriteException(exception)
            sentrinelPreviousExceptionHandler?(exception)
        }

        // An alternate stack, so a stack overflow — the stack is what ran out —
        // still has somewhere to run the handler.
        let altSize = 64 * 1024
        sentrinelAltStack = UnsafeMutableRawPointer.allocate(byteCount: altSize, alignment: 16)
        var stack = stack_t()
        stack.ss_sp = sentrinelAltStack
        stack.ss_size = altSize
        stack.ss_flags = 0
        sigaltstack(&stack, nil)

        for sig in sentrinelFatalSignals {
            var action = sigaction()
            action.__sigaction_u.__sa_sigaction = { sig, _, _ in
                sentrinelHandleSignal(sig)
            }
            action.sa_flags = SA_SIGINFO | SA_ONSTACK
            sigemptyset(&action.sa_mask)
            sigaction(sig, &action, sentrinelPreviousActions! + Int(sig))
        }
    }
}

// ── The signal path: async-signal-safe from here down ──────────────────────

func sentrinelHandleSignal(_ sig: Int32) {
    if sentrinelHandling == 0 {
        sentrinelHandling = 1
        // An uncaught NSException was already written with its name and
        // reason; the abort() it ends in is not a second crash.
        if !(sig == SIGABRT && sentrinelExceptionRecorded != 0) {
            sentrinelWriteSignalRecord(sig)
        }
    }
    // Hand the crash on: the previous handler (another reporter, or the
    // default that produces the system crash report) sees it as if we were
    // never here.
    if let previous = sentrinelPreviousActions {
        sigaction(sig, previous + Int(sig), nil)
    } else {
        signal(sig, SIG_DFL)
    }
    raise(sig)
}

@inline(never)
func sentrinelWriteSignalRecord(_ sig: Int32) {
    guard sentrinelCrashFd >= 0,
          let scratch = sentrinelScratch,
          let templates = sentrinelTemplates,
          let lengths = sentrinelTemplateLengths
    else { return }
    let active = sentrinelActiveTemplate
    let length = lengths[active]
    guard length > 0 else { return }

    var off = 0
    memcpy(scratch, templates + active * sentrinelTemplateCapacity, length)
    off = length
    sentrinelAppend(scratch, &off, "sigaction\"},\"timestamp\":\"")
    sentrinelAppendTimestamp(scratch, &off)
    sentrinelAppend(scratch, &off, "\",\"errorType\":\"Signal\",\"errorMessage\":\"")
    sentrinelAppend(scratch, &off, sentrinelSignalName(sig))
    sentrinelAppend(scratch, &off, "\",\"stackTrace\":\"")
    if let frames = sentrinelFrames {
        let count = Int(backtrace(frames, Int32(sentrinelMaxFrames)))
        var i = 0
        while i < count {
            sentrinelAppendHex(scratch, &off, UInt(bitPattern: frames[i]))
            sentrinelAppend(scratch, &off, "\\n")
            i += 1
        }
    }
    sentrinelAppend(scratch, &off, "\"}}\n")
    _ = write(sentrinelCrashFd, scratch, off)
}

func sentrinelSignalName(_ sig: Int32) -> StaticString {
    switch sig {
    case SIGABRT: return "SIGABRT"
    case SIGBUS: return "SIGBUS"
    case SIGFPE: return "SIGFPE"
    case SIGILL: return "SIGILL"
    case SIGSEGV: return "SIGSEGV"
    case SIGTRAP: return "SIGTRAP"
    default: return "SIGNAL"
    }
}

func sentrinelAppend(_ buf: UnsafeMutablePointer<UInt8>, _ off: inout Int, _ text: StaticString) {
    let count = text.utf8CodeUnitCount
    guard off + count < sentrinelScratchCapacity else { return }
    memcpy(buf + off, text.utf8Start, count)
    off += count
}

func sentrinelAppendByte(_ buf: UnsafeMutablePointer<UInt8>, _ off: inout Int, _ byte: UInt8) {
    guard off + 1 < sentrinelScratchCapacity else { return }
    buf[off] = byte
    off += 1
}

func sentrinelAppendHex(_ buf: UnsafeMutablePointer<UInt8>, _ off: inout Int, _ value: UInt) {
    sentrinelAppendByte(buf, &off, 0x30) // 0
    sentrinelAppendByte(buf, &off, 0x78) // x
    var shift = (MemoryLayout<UInt>.size * 8) - 4
    var started = false
    while shift >= 0 {
        let nibble = UInt8((value >> UInt(shift)) & 0xF)
        if nibble != 0 || started || shift == 0 {
            started = true
            sentrinelAppendByte(buf, &off, nibble < 10 ? 0x30 + nibble : 0x57 + nibble)
        }
        shift -= 4
    }
}

func sentrinelAppendDigits(_ buf: UnsafeMutablePointer<UInt8>, _ off: inout Int, _ value: Int, width: Int) {
    var divisor = 1
    var w = 1
    while w < width { divisor *= 10; w += 1 }
    var v = value
    while divisor > 0 {
        sentrinelAppendByte(buf, &off, UInt8(0x30 + (v / divisor) % 10))
        v %= divisor
        divisor /= 10
    }
}

/// `2026-09-28T10:15:02.123Z` from `clock_gettime`, by arithmetic alone —
/// `gmtime` and formatters are not async-signal-safe.
func sentrinelAppendTimestamp(_ buf: UnsafeMutablePointer<UInt8>, _ off: inout Int) {
    var ts = timespec()
    clock_gettime(CLOCK_REALTIME, &ts)
    let secs = Int(ts.tv_sec)
    let millis = Int(ts.tv_nsec) / 1_000_000
    // Howard Hinnant's civil_from_days.
    let days = secs / 86_400
    let rem = secs % 86_400
    let z = days + 719_468
    let era = (z >= 0 ? z : z - 146_096) / 146_097
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let day = doy - (153 * mp + 2) / 5 + 1
    let month = mp < 10 ? mp + 3 : mp - 9
    let year = yoe + era * 400 + (month <= 2 ? 1 : 0)

    sentrinelAppendDigits(buf, &off, year, width: 4)
    sentrinelAppendByte(buf, &off, 0x2D) // -
    sentrinelAppendDigits(buf, &off, month, width: 2)
    sentrinelAppendByte(buf, &off, 0x2D)
    sentrinelAppendDigits(buf, &off, day, width: 2)
    sentrinelAppendByte(buf, &off, 0x54) // T
    sentrinelAppendDigits(buf, &off, rem / 3600, width: 2)
    sentrinelAppendByte(buf, &off, 0x3A) // :
    sentrinelAppendDigits(buf, &off, (rem % 3600) / 60, width: 2)
    sentrinelAppendByte(buf, &off, 0x3A)
    sentrinelAppendDigits(buf, &off, rem % 60, width: 2)
    sentrinelAppendByte(buf, &off, 0x2E) // .
    sentrinelAppendDigits(buf, &off, millis, width: 3)
    sentrinelAppendByte(buf, &off, 0x5A) // Z
}

// ── The exception path: an ordinary context, so ordinary code is fine ──────

func sentrinelWriteException(_ exception: NSException) {
    guard sentrinelCrashFd >= 0,
          let templates = sentrinelTemplates,
          let lengths = sentrinelTemplateLengths
    else { return }
    let active = sentrinelActiveTemplate
    let length = lengths[active]
    guard length > 0 else { return }

    var line = Data(bytes: templates + active * sentrinelTemplateCapacity, count: length)
    let message = "\(exception.name.rawValue): \(exception.reason ?? "uncaught exception")"
    let stack = exception.callStackSymbols.joined(separator: "\n")
    line.append(Data((
        "\(CrashMechanism.nsException)\"},\"timestamp\":\"\(ErrorRecord.iso(Date()))\","
            + "\"errorType\":\"NSException\",\"errorMessage\":\"\(jsonEscaped(message))\","
            + "\"stackTrace\":\"\(jsonEscaped(stack))\"}}\n"
    ).utf8))
    line.withUnsafeBytes { raw in
        if let base = raw.baseAddress { _ = write(sentrinelCrashFd, base, raw.count) }
    }
    fsync(sentrinelCrashFd)
    sentrinelExceptionRecorded = 1
}

/// Where the main executable was loaded, so the return addresses a signal
/// report carries can be symbolicated against its dSYM later.
func sentrinelMainImage() -> (name: String, base: String)? {
    guard _dyld_image_count() > 0, let header = _dyld_get_image_header(0) else { return nil }
    let name = _dyld_get_image_name(0).map { String(cString: $0) } ?? ""
    let base = "0x" + String(UInt(bitPattern: header), radix: 16)
    return ((name as NSString).lastPathComponent, base)
}
