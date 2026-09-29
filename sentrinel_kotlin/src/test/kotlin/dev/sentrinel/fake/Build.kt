package dev.sentrinel.fake

/**
 * Stands in for `android.os.Build` so the reflection that reads it can be
 * tested on a plain JVM — same shape: static fields, and a nested `VERSION`.
 */
object Build {
    @JvmField val MANUFACTURER: String = "Google"
    @JvmField val MODEL: String = "Pixel 8"

    object VERSION {
        @JvmField val RELEASE: String = "14"
        @JvmField val SDK_INT: Int = 34
    }
}
