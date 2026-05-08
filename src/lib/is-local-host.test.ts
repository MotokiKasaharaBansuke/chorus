import { describe, it, expect } from "vitest";
import { isLocalHost } from "./is-local-host";

describe("isLocalHost", () => {
  it("returns true for localhost", () => {
    expect(isLocalHost("localhost")).toBe(true);
  });

  it("returns true for 0.0.0.0", () => {
    expect(isLocalHost("0.0.0.0")).toBe(true);
  });

  it("returns true for 127.0.0.1", () => {
    expect(isLocalHost("127.0.0.1")).toBe(true);
  });

  it("returns true for any 127.x.x.x address", () => {
    expect(isLocalHost("127.255.255.255")).toBe(true);
    expect(isLocalHost("127.0.0.2")).toBe(true);
  });

  it("returns true for IPv6 loopback [::1]", () => {
    expect(isLocalHost("[::1]")).toBe(true);
  });

  it("returns true for IPv4-mapped loopback [::ffff:7f00:1]", () => {
    expect(isLocalHost("[::ffff:7f00:1]")).toBe(true);
  });

  it("returns true for IPv4-mapped loopback range [::ffff:7fff:ffff]", () => {
    expect(isLocalHost("[::ffff:7fff:ffff]")).toBe(true);
  });

  it("returns false for public external hostnames", () => {
    expect(isLocalHost("example.com")).toBe(false);
    expect(isLocalHost("github.com")).toBe(false);
    expect(isLocalHost("192.168.1.1")).toBe(false);
  });

  it("returns false for a hostname that starts with 127 but is not IP", () => {
    // "127x.example.com" does not start with "127." so is external
    expect(isLocalHost("127x.example.com")).toBe(false);
  });

  it("returns false for a non-loopback IPv6 address", () => {
    expect(isLocalHost("[2001:db8::1]")).toBe(false);
    expect(isLocalHost("[fe80::1]")).toBe(false);
  });
});
