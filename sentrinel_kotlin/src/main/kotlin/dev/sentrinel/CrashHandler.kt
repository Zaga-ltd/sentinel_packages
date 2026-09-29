package dev.sentrinel

/**
 * Catches uncaught Kotlin/Java exceptions and hands them to the crash writer.
 *
 * On Android an uncaught exception on any thread kills the process, so this is
 * the "the app is about to die and we still have time to write" signal. SIGSEGV
 * and friends on Android are delivered to the native layer and are *not*
 * catchable from pure Kotlin — that would need a JNI handler, which is out of
 * scope for this package.
 *
 * Three properties, each of which the first version lacked:
 *
 *  * **Installed once.** A second `start()` used to wrap the handler around
 *    itself, so every crash was written once per `start()`.
 *  * **The previous handler always runs.** It is called in a `finally`: if
 *    writing the report throws, the system's crash dialog and process kill
 *    still happen — otherwise a broken report would leave a zombie app.
 *  * **Nothing it does can throw out of it.**
 */
internal object CrashHandler {
    @Volatile
    private var previous: Thread.UncaughtExceptionHandler? = null

    @Volatile
    private var installed = false

    /** Writes one crash report. Set by [Sentrinel.start]. */
    @Volatile
    var writer: ((thread: Thread, throwable: Throwable) -> Unit)? = null

    private object Handler : Thread.UncaughtExceptionHandler {
        override fun uncaughtException(thread: Thread, throwable: Throwable) {
            try {
                writer?.invoke(thread, throwable)
            } catch (_: Throwable) {
                // A monitoring SDK must not be the reason a crash gets worse.
            } finally {
                val previous = previous
                if (previous != null) {
                    previous.uncaughtException(thread, throwable)
                } else {
                    // What the JVM does with no handler at all. Not
                    // ThreadGroup.uncaughtException: that asks the default
                    // handler — this one — and would loop.
                    System.err.print("Exception in thread \"${thread.name}\" ")
                    throwable.printStackTrace(System.err)
                }
            }
        }
    }

    @Synchronized
    fun install() {
        if (installed) return
        val current = Thread.getDefaultUncaughtExceptionHandler()
        if (current !== Handler) previous = current
        Thread.setDefaultUncaughtExceptionHandler(Handler)
        installed = true
    }

    /** Test seam: put back whatever was there before. */
    @Synchronized
    internal fun uninstall() {
        if (!installed) return
        if (Thread.getDefaultUncaughtExceptionHandler() === Handler) {
            Thread.setDefaultUncaughtExceptionHandler(previous)
        }
        previous = null
        installed = false
    }
}
