plugins {
    kotlin("jvm") version "2.0.21"
    `java-library`
    `maven-publish`
}

// JitPack builds this from the public repo and serves whatever lands in the
// local Maven repository. It passes its own coordinates in (see the repo's
// root jitpack.yml): `com.github.Zaga-ltd.sentinel_packages:sentrinel_kotlin`.
// A plain `./gradlew build` keeps the library's own name.
group = (findProperty("sentrinelGroup") as String?)?.takeIf { it.isNotBlank() } ?: "dev.sentrinel"
version = (findProperty("sentrinelVersion") as String?)?.takeIf { it.isNotBlank() } ?: "0.2.0"

repositories {
    mavenCentral()
}

dependencies {
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(11)
}

java {
    withSourcesJar()
}

tasks.test {
    useJUnitPlatform()
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            artifactId = "sentrinel_kotlin"
            from(components["java"])
        }
    }
}
