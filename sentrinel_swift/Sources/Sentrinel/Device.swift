// ─── Device facts — the context that turns a stack trace into a diagnosis ───

import Foundation

#if canImport(UIKit)
import UIKit
#endif

/// The SDK's name and version, sent on every batch and in the User-Agent.
public enum SentrinelSDK {
    public static let name = "sentrinel.swift"
    public static let version = "0.2.0"
}

/// Device facts available without an extra permission or dependency.
///
/// The dotted keys match the Flutter SDK's `deviceContext()`, so a native crash
/// and a Dart crash render identically in the dashboard.
enum Device {
    /// The OS in the API's spelling — what sessions carry as `deviceOs`, and the
    /// vocabulary the server already uses for browsers.
    static var osName: String {
        #if os(iOS)
        return "iOS"
        #elseif os(tvOS)
        return "tvOS"
        #elseif os(watchOS)
        return "watchOS"
        #elseif os(macOS)
        return "macOS"
        #else
        return "unknown"
        #endif
    }

    /// `17.4` or `17.4.1` — thread-safe, unlike `UIDevice.systemVersion`.
    static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return v.patchVersion == 0
            ? "\(v.majorVersion).\(v.minorVersion)"
            : "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    /// The hardware identifier — `iPhone15,2`, `iPad13,1`, `Mac14,2`.
    ///
    /// `UIDevice.model` says only "iPhone", which cannot tell a phone from
    /// last year from one from 2017. On a simulator the host's machine is
    /// `arm64`, so the simulated model is read from the environment instead.
    static var model: String? {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return simulated
        }
        var info = utsname()
        uname(&info)
        let machine = withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) }
        }
        return machine.isEmpty ? nil : machine
    }

    /// `mobile`, `tablet` or `desktop`. UIKit may only be asked on the main
    /// thread; off it, a phone OS is assumed to be a phone.
    static var deviceType: String {
        #if os(iOS)
        if Thread.isMainThread {
            return UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "mobile"
        }
        return "mobile"
        #elseif os(macOS)
        return "desktop"
        #else
        return "mobile"
        #endif
    }

    static var context: [String: Any] {
        var facts: [String: Any] = [:]
        #if os(iOS)
        facts["device.os"] = "ios"
        #elseif os(macOS)
        facts["device.os"] = "macos"
        #endif
        facts["device.os_version"] = osVersion
        if let model { facts["device.model"] = model }
        facts["device.type"] = deviceType
        facts["device.cores"] = ProcessInfo.processInfo.activeProcessorCount
        facts["runtime.swift"] = swiftVersion()
        return facts
    }

    /// `sentrinel.swift/0.2.0 (iOS 17.4; iPhone)` — built so the API's
    /// User-Agent parser reads it as the device it came from.
    static func userAgent(deviceType: String) -> String {
        let platform: String
        switch osName {
        case "iOS": platform = "iOS \(osVersion); \(deviceType == "tablet" ? "iPad" : "iPhone")"
        case "macOS": platform = "Macintosh; Mac OS X \(osVersion)"
        default: platform = "\(osName) \(osVersion)"
        }
        return "\(SentrinelSDK.name)/\(SentrinelSDK.version) (\(platform))"
    }

    private static func swiftVersion() -> String {
        #if swift(>=6.0)
        return "6.0+"
        #elseif swift(>=5.9)
        return "5.9+"
        #else
        return "unknown"
        #endif
    }
}
