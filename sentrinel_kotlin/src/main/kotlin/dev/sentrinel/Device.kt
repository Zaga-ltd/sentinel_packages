package dev.sentrinel

/** The SDK's name and version, sent on every batch and in the User-Agent. */
object SentrinelSdk {
    const val NAME = "sentrinel.kotlin"
    const val VERSION = "0.2.0"
}

/**
 * The device, in the API's vocabulary: [os] is `Android` / `Linux` / `macOS` /
 * `Windows`, [deviceType] is `mobile` / `tablet` / `desktop`.
 */
data class DeviceFacts(
    val os: String?,
    val osVersion: String?,
    val deviceType: String?,
    val model: String?,
    val isAndroid: Boolean,
)

/**
 * Device facts available without an extra permission or dependency.
 *
 * Uses the same dotted keys as the Flutter SDK's `deviceContext()` and the Swift
 * SDK's `Device.context`, so a native crash and a Dart crash render identically
 * in the dashboard.
 *
 * The library has no Android SDK dependency, so on Android `android.os.Build` is
 * read by reflection. Without it the JVM's own properties said "linux" and the
 * kernel version — every Android phone reported as a Linux desktop.
 */
internal object Device {
    /** Read the facts. [buildClass] is a test seam for the reflection. */
    fun facts(buildClass: String = "android.os.Build"): DeviceFacts {
        val android = androidFacts(buildClass)
        if (android != null) return android
        val name = System.getProperty("os.name") ?: ""
        val os = when {
            name.startsWith("Mac", ignoreCase = true) -> "macOS"
            name.startsWith("Windows", ignoreCase = true) -> "Windows"
            name.startsWith("Linux", ignoreCase = true) -> "Linux"
            name.isEmpty() -> null
            else -> name
        }
        return DeviceFacts(
            os = os,
            osVersion = System.getProperty("os.version"),
            deviceType = "desktop",
            model = null,
            isAndroid = false,
        )
    }

    private fun androidFacts(buildClass: String): DeviceFacts? = try {
        val build = Class.forName(buildClass)
        val version = Class.forName("$buildClass\$VERSION")
        val release = version.getField("RELEASE").get(null) as? String
        val manufacturer = build.getField("MANUFACTURER").get(null) as? String
        val model = build.getField("MODEL").get(null) as? String
        DeviceFacts(
            os = "Android",
            osVersion = release,
            // A phone until told otherwise — telling a tablet apart needs a
            // Context. See Sentrinel.setDeviceInfo.
            deviceType = "mobile",
            model = listOfNotNull(manufacturer, model)
                .joinToString(" ")
                .takeIf { it.isNotBlank() },
            isAndroid = true,
        )
    } catch (_: Throwable) {
        null
    }

    fun context(facts: DeviceFacts): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>()
        out["device.os"] = facts.os?.lowercase() ?: "unknown"
        out["device.os_version"] = facts.osVersion
        facts.model?.let { out["device.model"] = it }
        facts.deviceType?.let { out["device.type"] = it }
        out["device.cores"] = Runtime.getRuntime().availableProcessors()
        if (!facts.isAndroid) out["runtime.java"] = System.getProperty("java.version")
        return out
    }

    /**
     * `sentrinel.kotlin/0.2.0 (Android 14; Mobile)` — built so the API's
     * User-Agent parser reads it as the device it came from.
     */
    fun userAgent(facts: DeviceFacts): String {
        val version = facts.osVersion?.let { " $it" } ?: ""
        val platform = when (facts.os) {
            "Android" -> "Android$version; ${if (facts.deviceType == "tablet") "Tablet" else "Mobile"}"
            "macOS" -> "Macintosh; Mac OS X$version"
            "Windows" -> "Windows NT$version"
            null -> "unknown"
            else -> "${facts.os}$version"
        }
        return "${SentrinelSdk.NAME}/${SentrinelSdk.VERSION} ($platform)"
    }
}
