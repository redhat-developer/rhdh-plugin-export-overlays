/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vite-plus/test";
import {
  errorProperty,
  isPlainObject,
  sanitizeLog,
  sanitizeNumber,
  trimTrailingSlashes,
} from "../helpers.ts";

describe("helpers", () => {
  describe("isPlainObject", () => {
    it("returns true for plain objects", () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
    });

    it("returns false for null, arrays, primitives", () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject("string")).toBe(false);
      expect(isPlainObject(123)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
    });
  });

  describe("errorProperty", () => {
    it("reads property if present on object", () => {
      const err = new Error("failed");
      Reflect.set(err, "status", 404);
      expect(errorProperty(err, "status")).toBe(404);
    });

    it("returns undefined if property is absent or target is not object", () => {
      expect(errorProperty(new Error("oops"), "missing")).toBeUndefined();
      expect(errorProperty("not an error", "status")).toBeUndefined();
      expect(errorProperty(null, "status")).toBeUndefined();
    });
  });

  describe("trimTrailingSlashes", () => {
    it("trims single or multiple trailing slashes without regex backtracking", () => {
      expect(trimTrailingSlashes("https://api.github.com/")).toBe("https://api.github.com");
      expect(trimTrailingSlashes("https://api.github.com///")).toBe("https://api.github.com");
      expect(trimTrailingSlashes("https://api.github.com")).toBe("https://api.github.com");
    });
  });

  describe("sanitizeLog", () => {
    it("strips carriage returns and newlines", () => {
      expect(sanitizeLog("hello\r\nworld\n")).toBe("hello world");
    });

    it("strips percent-encoded newlines", () => {
      expect(sanitizeLog("attack%0Acmd%0Dtest")).toBe("attack cmd test");
    });

    it("neutralizes GHA :: command tokens", () => {
      expect(sanitizeLog("::set-output name=foo::bar")).toBe(": :set-output name=foo: :bar");
    });

    it("strips ANSI escape codes", () => {
      const ESC = String.fromCharCode(27);
      const colored = `${ESC}[31mRed text${ESC}[0m`;
      expect(sanitizeLog(colored)).toBe("Red text");
    });

    it("handles null and undefined safely", () => {
      expect(sanitizeLog(null)).toBe("");
      expect(sanitizeLog(undefined)).toBe("");
    });
  });

  describe("sanitizeNumber", () => {
    it("returns integer for valid positive numbers", () => {
      expect(sanitizeNumber(42)).toBe(42);
      expect(sanitizeNumber("42")).toBe(42);
    });

    it("returns 0 for negative numbers, zero, or invalid values", () => {
      expect(sanitizeNumber(-5)).toBe(0);
      expect(sanitizeNumber(0)).toBe(0);
      expect(sanitizeNumber("invalid")).toBe(0);
      expect(sanitizeNumber(NaN)).toBe(0);
    });
  });
});
