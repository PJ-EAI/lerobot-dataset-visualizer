import { describe, expect, test } from "bun:test";

import {
  isLocalRepoId,
  localDatasetHref,
  localTokenFrom,
  looksLikeLocalPath,
} from "@/utils/localDataset";

describe("isLocalRepoId", () => {
  test("accepts the reserved local org", () => {
    expect(isLocalRepoId("local/L2hvbWUvcHVzaHQ")).toBe(true);
  });

  test("rejects Hub ids, including ones that merely start with the letters", () => {
    expect(isLocalRepoId("lerobot/pusht")).toBe(false);
    expect(isLocalRepoId("locality/dataset")).toBe(false);
    expect(isLocalRepoId("local")).toBe(false);
  });
});

describe("localTokenFrom", () => {
  test("strips the org prefix", () => {
    expect(localTokenFrom("local/abc-_123")).toBe("abc-_123");
  });
});

describe("localDatasetHref", () => {
  test("defaults to the first episode", () => {
    expect(localDatasetHref("abc")).toBe("/local/abc/episode_0");
  });

  test("takes an episode index", () => {
    expect(localDatasetHref("abc", 7)).toBe("/local/abc/episode_7");
  });
});

describe("looksLikeLocalPath", () => {
  test("recognises absolute, home-relative and Windows paths", () => {
    expect(looksLikeLocalPath("/home/ethan/datasets/pusht")).toBe(true);
    expect(looksLikeLocalPath("~/datasets/pusht")).toBe(true);
    expect(looksLikeLocalPath("  /tmp/x  ")).toBe(true);
    expect(looksLikeLocalPath("C:\\datasets")).toBe(true);
  });

  test("leaves Hub repo ids alone", () => {
    expect(looksLikeLocalPath("lerobot/pusht")).toBe(false);
    expect(looksLikeLocalPath("org/name")).toBe(false);
    expect(looksLikeLocalPath("")).toBe(false);
    expect(looksLikeLocalPath("   ")).toBe(false);
  });
});
