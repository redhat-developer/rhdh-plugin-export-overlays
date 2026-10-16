/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import {
  cleanVersion,
  compareVersions,
  isEqualVersion,
  isNewerVersion,
} from "../semver-compare.ts";

describe("semver-compare", () => {
  describe("cleanVersion", () => {
    it("cleans simple semver strings", () => {
      expect(cleanVersion("1.2.3")).toBe("1.2.3");
    });

    it("strips leading v from tags", () => {
      expect(cleanVersion("v1.54.9")).toBe("1.54.9");
    });

    it("handles pre-release tags", () => {
      expect(cleanVersion("v2.0.0-alpha.1")).toBe("2.0.0-alpha.1");
    });

    it("returns null on invalid non-version strings", () => {
      expect(cleanVersion("not-a-version")).toBeNull();
    });
  });

  describe("compareVersions", () => {
    it("returns 1 when v1 > v2", () => {
      expect(compareVersions("3.1.0", "1.13.4")).toBe(1);
      expect(compareVersions("v1.54.9", "1.54.6")).toBe(1);
      expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    });

    it("returns -1 when v1 < v2", () => {
      expect(compareVersions("1.13.4", "3.1.0")).toBe(-1);
      expect(compareVersions("1.54.6", "v1.54.9")).toBe(-1);
    });

    it("returns 0 when v1 == v2", () => {
      expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
      expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    });
  });

  describe("isNewerVersion", () => {
    it("identifies strictly newer versions", () => {
      expect(isNewerVersion("3.1.0", "1.13.4")).toBe(true);
      expect(isNewerVersion("1.54.9", "1.54.6")).toBe(true);
      expect(isNewerVersion("0.2.1", "0.1.3")).toBe(true);
    });

    it("returns false for equal versions", () => {
      expect(isNewerVersion("1.13.4", "1.13.4")).toBe(false);
      expect(isNewerVersion("v1.54.9", "1.54.9")).toBe(false);
    });

    it("returns false for older versions", () => {
      expect(isNewerVersion("1.13.4", "3.1.0")).toBe(false);
    });
  });

  describe("isEqualVersion", () => {
    it("identifies equivalent semver versions", () => {
      expect(isEqualVersion("v1.2.3", "1.2.3")).toBe(true);
      expect(isEqualVersion("2.0.0", "2.0.1")).toBe(false);
    });
  });
});
