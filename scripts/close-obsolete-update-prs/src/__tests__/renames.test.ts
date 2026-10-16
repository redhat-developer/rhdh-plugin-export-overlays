/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import { resolveCurrentPackageName, resolveCurrentWorkspaceName } from "../renames.ts";

describe("renames", () => {
  describe("resolveCurrentWorkspaceName", () => {
    it("resolves historical workspace renames", () => {
      expect(resolveCurrentWorkspaceName("marketplace")).toBe("extensions");
      expect(resolveCurrentWorkspaceName("redhat-resource-optimization")).toBe("cost-management");
      expect(resolveCurrentWorkspaceName("redhat-argocd")).toBe("argocd");
      expect(resolveCurrentWorkspaceName("aws-ecs")).toBe("backstage-plugins-for-aws");
      expect(resolveCurrentWorkspaceName("github-actions")).toBe("github");
    });

    it("returns unmodified name for unrenamed workspaces", () => {
      expect(resolveCurrentWorkspaceName("homepage")).toBe("homepage");
      expect(resolveCurrentWorkspaceName("x2a")).toBe("x2a");
      expect(resolveCurrentWorkspaceName("intelligent-assistant")).toBe("intelligent-assistant");
    });
  });

  describe("resolveCurrentPackageName", () => {
    it("resolves dynamic-home-page to homepage", () => {
      expect(
        resolveCurrentPackageName("@red-hat-developer-hub/backstage-plugin-dynamic-home-page"),
      ).toBe("@red-hat-developer-hub/backstage-plugin-homepage");
    });

    it("resolves boost to ai-catalog", () => {
      expect(resolveCurrentPackageName("@red-hat-developer-hub/backstage-plugin-boost")).toBe(
        "@red-hat-developer-hub/backstage-plugin-ai-catalog",
      );
    });

    it("resolves x2a scaffolder module rename", () => {
      expect(
        resolveCurrentPackageName(
          "@red-hat-developer-hub/backstage-plugin-scaffolder-backend-module-x2a",
        ),
      ).toBe("@red-hat-developer-hub/backstage-plugin-x2a-scaffolder-module");
    });

    it("leaves standard packages untouched", () => {
      expect(resolveCurrentPackageName("@red-hat-developer-hub/backstage-plugin-homepage")).toBe(
        "@red-hat-developer-hub/backstage-plugin-homepage",
      );
      expect(
        resolveCurrentPackageName("@red-hat-developer-hub/backstage-plugin-homepage-backend"),
      ).toBe("@red-hat-developer-hub/backstage-plugin-homepage-backend");
    });
  });
});
