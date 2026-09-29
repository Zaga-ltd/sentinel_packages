package dev.sentrinel

import java.io.File

/**
 * Minimal JSON support. Kotlin's stdlib has none, and adding kotlinx-serialization
 * would be a bigger dependency than this needs — every shape this SDK sends is a
 * `Map<String, Any?>` of scalars and lists, and the only JSON we ever parse back
 * is what we wrote ourselves.
 */
internal object Json {
    fun encode(value: Any?): String {
        val sb = StringBuilder()
        write(sb, value)
        return sb.toString()
    }

    fun encodeLine(kind: String, record: Map<String, Any?>): String =
        encode(mapOf("kind" to kind, "record" to record)) + "\n"

    private fun write(sb: StringBuilder, value: Any?) {
        when (value) {
            null -> sb.append("null")
            is Boolean -> sb.append(if (value) "true" else "false")
            is Number -> {
                if (value is Double || value is Float) {
                    val d = value.toDouble()
                    if (d.isFinite()) sb.append(d) else sb.append("null")
                } else {
                    sb.append(value.toString())
                }
            }
            is String -> writeString(sb, value)
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    first = false
                    writeString(sb, k.toString())
                    sb.append(':')
                    write(sb, v)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (item in value) {
                    if (!first) sb.append(',')
                    first = false
                    write(sb, item)
                }
                sb.append(']')
            }
            is Array<*> -> {
                sb.append('[')
                var first = true
                for (item in value) {
                    if (!first) sb.append(',')
                    first = false
                    write(sb, item)
                }
                sb.append(']')
            }
            else -> writeString(sb, value.toString())
        }
    }

    private fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (c.code < 0x20) sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }

    /** Parse one JSON value. Lenient enough for what we wrote ourselves. */
    fun parse(text: String): Any? {
        val parser = Parser(text)
        return parser.parseValue()
    }

    private class Parser(private val text: String) {
        private var pos = 0

        fun parseValue(): Any? {
            skipWhitespace()
            if (pos >= text.length) return null
            return when (text[pos]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> parseString()
                't' -> { expect("true"); true }
                'f' -> { expect("false"); false }
                'n' -> { expect("null"); null }
                else -> parseNumber()
            }
        }

        private fun parseObject(): Map<String, Any?> {
            pos++ // {
            val out = mutableMapOf<String, Any?>()
            skipWhitespace()
            if (pos < text.length && text[pos] == '}') { pos++; return out }
            while (pos < text.length) {
                skipWhitespace()
                val key = parseString()
                skipWhitespace()
                if (pos < text.length && text[pos] == ':') pos++
                out[key] = parseValue()
                skipWhitespace()
                if (pos < text.length && text[pos] == ',') { pos++; continue }
                if (pos < text.length && text[pos] == '}') { pos++; break }
            }
            return out
        }

        private fun parseArray(): List<Any?> {
            pos++ // [
            val out = mutableListOf<Any?>()
            skipWhitespace()
            if (pos < text.length && text[pos] == ']') { pos++; return out }
            while (pos < text.length) {
                out.add(parseValue())
                skipWhitespace()
                if (pos < text.length && text[pos] == ',') { pos++; continue }
                if (pos < text.length && text[pos] == ']') { pos++; break }
            }
            return out
        }

        private fun parseString(): String {
            val sb = StringBuilder()
            if (pos < text.length && text[pos] == '"') pos++
            while (pos < text.length) {
                val c = text[pos]
                if (c == '"') { pos++; return sb.toString() }
                if (c == '\\') {
                    pos++
                    if (pos >= text.length) break
                    when (val e = text[pos]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'u' -> {
                            if (pos + 4 < text.length) {
                                val hex = text.substring(pos + 1, pos + 5)
                                sb.append(hex.toIntOrNull(16)?.toChar() ?: '?')
                                pos += 4
                            }
                        }
                        else -> sb.append(e)
                    }
                    pos++
                } else {
                    sb.append(c)
                    pos++
                }
            }
            return sb.toString()
        }

        private fun parseNumber(): Any? {
            val start = pos
            while (pos < text.length && (text[pos].isDigit() || text[pos] in "-+eE.")) pos++
            val raw = text.substring(start, pos)
            return raw.toLongOrNull() ?: raw.toDoubleOrNull() ?: raw
        }

        private fun skipWhitespace() {
            while (pos < text.length && text[pos].isWhitespace()) pos++
        }

        private fun expect(word: String) {
            if (text.startsWith(word, pos)) pos += word.length
        }
    }
}
