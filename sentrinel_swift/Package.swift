// swift-tools-version: 5.10
// ─── Sentrinel for iOS / macOS ──────────────────────────────────────────────
//
// The native half of crash reporting: a Swift package that catches what the
// Flutter/Dart SDK cannot — a segfault, an ObjC exception, a signal — and posts
// the *same* error shape the Flutter SDK sends, so one dashboard groups native
// and Dart crashes together. See the AGENTS.md roadmap, gap 3.

import PackageDescription

let package = Package(
    name: "sentrinel",
    platforms: [
        .iOS(.v13),
        .macOS(.v10_15),
    ],
    products: [
        .library(name: "Sentrinel", targets: ["Sentrinel"])
    ],
    targets: [
        .target(name: "Sentrinel"),
        .testTarget(name: "SentrinelTests", dependencies: ["Sentrinel"]),
    ]
)
