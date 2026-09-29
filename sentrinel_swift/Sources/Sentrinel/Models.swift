// ─── Wire shapes — mirror packages/sentrinel_flutter/lib/src/models.dart ────
//
// These are deliberately kept byte-for-byte compatible with the Flutter SDK's
// records, because both hit the same ingest contract in
// apps/api/src/routes/ingest.ts. A native crash and a Dart crash must land in
// the same issues, sessions and consumers — the server cannot tell them apart,
// and it should not have to.

import Foundation

/// A failure: a caught exception, an uncaught crash, or an error response.
///
/// Matches `ErrorRecord` in the Flutter SDK. `method`/`path` are the minimal
/// endpoint identifiers the server fingerprints issues on — native crashes use
/// `APP` and `app/crash`, the same convention the Flutter SDK uses for fatal
/// Dart errors.
struct ErrorRecord: Codable {
    var method: String = "APP"
    var path: String
    var statusCode: Int = 500
    var timestamp: Date = Date()
    var statusMessage: String?
    var errorType: String?
    var errorMessage: String?
    var stackTrace: String?
    var consumerIdentifier: String?
    var requestLogId: String?
    var traceId: String?
    var attributes: [String: Any]?

    enum CodingKeys: String, CodingKey {
        case method, path, statusCode, timestamp, statusMessage
        case errorType, errorMessage, stackTrace, consumerIdentifier
        case requestLogId, traceId, attributes
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(method, forKey: .method)
        try c.encode(path, forKey: .path)
        try c.encode(statusCode, forKey: .statusCode)
        try c.encode(Self.iso(timestamp), forKey: .timestamp)
        try c.encodeIfPresent(statusMessage, forKey: .statusMessage)
        try c.encodeIfPresent(errorType, forKey: .errorType)
        try c.encodeIfPresent(errorMessage, forKey: .errorMessage)
        try c.encodeIfPresent(stackTrace, forKey: .stackTrace)
        try c.encodeIfPresent(consumerIdentifier, forKey: .consumerIdentifier)
        try c.encodeIfPresent(requestLogId, forKey: .requestLogId)
        try c.encodeIfPresent(traceId, forKey: .traceId)
        // The server accepts any attribute object; encode our dictionary as a
        // nested JSON object rather than a JSON string.
        if let attributes, !attributes.isEmpty {
            try c.encode(AttributesValue(attributes), forKey: .attributes)
        }
    }

    init(
        method: String = "APP",
        path: String,
        statusCode: Int = 500,
        timestamp: Date = Date(),
        statusMessage: String? = nil,
        errorType: String? = nil,
        errorMessage: String? = nil,
        stackTrace: String? = nil,
        consumerIdentifier: String? = nil,
        requestLogId: String? = nil,
        traceId: String? = nil,
        attributes: [String: Any]? = nil
    ) {
        self.method = method
        self.path = path
        self.statusCode = statusCode
        self.timestamp = timestamp
        self.statusMessage = statusMessage
        self.errorType = errorType
        self.errorMessage = errorMessage
        self.stackTrace = stackTrace
        self.consumerIdentifier = consumerIdentifier
        self.requestLogId = requestLogId
        self.traceId = traceId
        self.attributes = attributes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        method = try c.decodeIfPresent(String.self, forKey: .method) ?? "APP"
        path = try c.decode(String.self, forKey: .path)
        statusCode = try c.decodeIfPresent(Int.self, forKey: .statusCode) ?? 500
        timestamp = Self.isoFormatter.date(from: try c.decode(String.self, forKey: .timestamp)) ?? Date()
        statusMessage = try c.decodeIfPresent(String.self, forKey: .statusMessage)
        errorType = try c.decodeIfPresent(String.self, forKey: .errorType)
        errorMessage = try c.decodeIfPresent(String.self, forKey: .errorMessage)
        stackTrace = try c.decodeIfPresent(String.self, forKey: .stackTrace)
        consumerIdentifier = try c.decodeIfPresent(String.self, forKey: .consumerIdentifier)
        requestLogId = try c.decodeIfPresent(String.self, forKey: .requestLogId)
        traceId = try c.decodeIfPresent(String.self, forKey: .traceId)
        attributes = try c.decodeIfPresent([String: AnyCodable].self, forKey: .attributes)?.mapValues { $0.value }
    }

    static func iso(_ date: Date) -> String {
        // Same format the Dart SDK emits: ISO-8601 with fractional seconds, UTC.
        isoFormatter.string(from: date)
    }

    static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

/// One app launch — the denominator for crash-free rate.
///
/// Matches `SessionRecord` in the Flutter SDK. Reported at launch and again at
/// shutdown; the server upserts on sessionId and only ever lets status worsen,
/// so the order the two arrive in does not matter.
struct SessionRecord: Codable {
    var sessionId: String
    /// `ok` · `crashed` · `abnormal` · `errored`
    var status: String
    var startedAt: Date = Date()
    var release: String?
    var distinctId: String?
    var deviceOs: String?
    var deviceOsVersion: String?
    var durationMs: Double?

    enum CodingKeys: String, CodingKey {
        case sessionId, status, startedAt, release, distinctId
        case deviceOs, deviceOsVersion, durationMs
    }

    init(
        sessionId: String,
        status: String,
        startedAt: Date = Date(),
        release: String? = nil,
        distinctId: String? = nil,
        deviceOs: String? = nil,
        deviceOsVersion: String? = nil,
        durationMs: Double? = nil
    ) {
        self.sessionId = sessionId
        self.status = status
        self.startedAt = startedAt
        self.release = release
        self.distinctId = distinctId
        self.deviceOs = deviceOs
        self.deviceOsVersion = deviceOsVersion
        self.durationMs = durationMs
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(status, forKey: .status)
        try c.encode(ErrorRecord.iso(startedAt), forKey: .startedAt)
        try c.encodeIfPresent(release, forKey: .release)
        try c.encodeIfPresent(distinctId, forKey: .distinctId)
        try c.encodeIfPresent(deviceOs, forKey: .deviceOs)
        try c.encodeIfPresent(deviceOsVersion, forKey: .deviceOsVersion)
        try c.encodeIfPresent(durationMs, forKey: .durationMs)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        status = try c.decode(String.self, forKey: .status)
        startedAt = ErrorRecord.isoFormatter.date(from: try c.decode(String.self, forKey: .startedAt)) ?? Date()
        release = try c.decodeIfPresent(String.self, forKey: .release)
        distinctId = try c.decodeIfPresent(String.self, forKey: .distinctId)
        deviceOs = try c.decodeIfPresent(String.self, forKey: .deviceOs)
        deviceOsVersion = try c.decodeIfPresent(String.self, forKey: .deviceOsVersion)
        durationMs = try c.decodeIfPresent(Double.self, forKey: .durationMs)
    }
}

/// A heterogeneous value dictionary that encodes as a JSON object.
///
/// `Encodable` on `[String: Any]` is not conformance, and `JSONSerialization`
/// at this layer would fight the coding machinery. `AnyEncodable` gives us a
/// lossless bridge for the attributes the SDK sends.
///
/// It never throws. JSON has no spelling for `NaN` or `±Infinity`, and
/// `JSONEncoder` throws on them — one `0/0` in one attribute used to fail the
/// encode of the whole batch, which then went out as `{"errors":null}`. They
/// encode as `null` instead, and anything unrecognised as its description.
struct AnyEncodable: Encodable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let v as String:
            try container.encode(v)
        case is NSNull:
            try container.encodeNil()
        // Swift's own scalar types first, by exact type: on Apple platforms an
        // `Int` also casts to `Bool` and a `Bool` to `Int` through NSNumber.
        case let v as Bool where type(of: value) == Bool.self:
            try container.encode(v)
        case let v as Int where type(of: value) == Int.self:
            try container.encode(v)
        case let v as Double where type(of: value) == Double.self:
            if v.isFinite { try container.encode(v) } else { try container.encodeNil() }
        case let v as Float where type(of: value) == Float.self:
            if v.isFinite { try container.encode(v) } else { try container.encodeNil() }
        case let v as NSNumber:
            // Everything else numeric: other integer widths, CGFloat, and
            // values that came back from JSONSerialization.
            if CFGetTypeID(v) == CFBooleanGetTypeID() {
                try container.encode(v.boolValue)
            } else if CFNumberIsFloatType(v) {
                let d = v.doubleValue
                if d.isFinite { try container.encode(d) } else { try container.encodeNil() }
            } else {
                try container.encode(v.int64Value)
            }
        case let v as Date:
            try container.encode(ErrorRecord.iso(v))
        case let v as URL:
            try container.encode(v.absoluteString)
        case let v as [String: Any]:
            try container.encode(AttributesValue(v))
        case let v as [Any]:
            try container.encode(v.map { AnyEncodable($0) })
        default:
            try container.encode(String(describing: value))
        }
    }
}

/// A fresh encoder per use (`JSONEncoder` is not documented thread-safe), with
/// slashes left alone: `app/crash`, not `app\/crash`, in files people read.
func makeEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return encoder
}

/// `value` as the contents of a JSON string literal, without the quotes.
func jsonEscaped(_ value: String) -> String {
    var out = ""
    out.reserveCapacity(value.utf8.count)
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out
}

/// The decode mirror of [AnyEncodable] — turns an attribute object back into a
/// `[String: Any]` when replaying a crash report from disk.
struct AnyCodable: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let v = try? container.decode(Bool.self) {
            value = v
        } else if let v = try? container.decode(Int.self) {
            value = v
        } else if let v = try? container.decode(Double.self) {
            value = v
        } else if let v = try? container.decode(String.self) {
            value = v
        } else if let v = try? container.decode([String: AnyCodable].self) {
            value = v.mapValues { $0.value }
        } else if let v = try? container.decode([AnyCodable].self) {
            value = v.map { $0.value }
        } else {
            value = NSNull()
        }
    }
}

/// A JSON-object wrapper for a `[String: Any]` dictionary.
struct AttributesValue: Encodable {
    let fields: [String: Any]

    init(_ fields: [String: Any]) {
        self.fields = fields
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicKey.self)
        for (key, value) in fields {
            try container.encode(AnyEncodable(value), forKey: DynamicKey(key))
        }
    }
}

struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
    init(_ string: String) { self.stringValue = string }
}

/// One thing the app did, kept to explain what led to a failure.
struct Breadcrumb: Encodable {
    var timestamp: Date = Date()
    var category: String
    var message: String
    var data: [String: Any]?

    enum CodingKeys: String, CodingKey { case timestamp, category, message, data }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ErrorRecord.iso(timestamp), forKey: .timestamp)
        try c.encode(category, forKey: .category)
        try c.encode(message, forKey: .message)
        if let data, !data.isEmpty {
            try c.encode(AttributesValue(data), forKey: .data)
        }
    }
}

/// A bounded trail of recent activity. Same fixed-size rationale as the Flutter
/// SDK: the twenty things immediately before a crash explain it better than the
/// two thousand before those.
struct BreadcrumbTrail {
    let limit: Int
    private var crumbs: [Breadcrumb] = []

    init(limit: Int = 25) {
        self.limit = limit
    }

    mutating func add(_ crumb: Breadcrumb) {
        crumbs.append(crumb)
        if crumbs.count > limit {
            crumbs.removeFirst(crumbs.count - limit)
        }
    }

    var count: Int { crumbs.count }
    var json: [[String: Any]] {
        crumbs.map { (try? JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) as? [String: Any]) ?? [:] }
    }
}
