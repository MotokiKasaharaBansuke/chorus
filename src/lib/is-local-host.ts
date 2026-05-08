/**
 * Returns true for hostnames that resolve to the local machine.
 * Used by the global external-link interceptor to avoid opening
 * local addresses (Tauri backend, dev server, etc.) in the OS browser.
 *
 * Covers:
 *   - Named aliases: localhost, 0.0.0.0
 *   - IPv4 loopback: 127.0.0.0/8  (127.x.x.x)
 *   - IPv6 loopback: ::1
 *   - IPv4-mapped loopback: ::ffff:127.x.x.x  (e.g. [::ffff:7f00:1])
 */
export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("[::ffff:7f"); // IPv4-mapped loopback (::ffff:127.x.x.x)
}
