plugins {
    // Fetches a JDK for the toolchain when the machine has none, so
    // `./gradlew build` works on a fresh checkout without installing Java 11
    // by hand. The wrapper pins Gradle itself for the same reason.
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

rootProject.name = "sentrinel_kotlin"
