/**
 * The file-serving route hands out bytes from disk, so these tests pin down the containment rules
 * that stop it from handing out anything else.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  allowedRealBases,
  encodeLocalToken,
  isLocalDatasetsEnabled,
  localDatasetLabel,
  normalizeLocalPath,
  resolveDatasetFilePath,
  resolveLocalDatasetRoot,
  resolveLocalToken,
} from "@/lib/localDatasetServer";

let tmp: string;

/** `<tmp>/plain` — a dataset in the `local_dir` layout. */
let plainRoot: string;
/** `<tmp>/container` — a dataset in the hub-cache layout, files symlinked into `blobs/`. */
let cacheRoot: string;
let cacheContainer: string;

async function write(file: string, contents: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lerobot-local-test-"));

  plainRoot = path.join(tmp, "plain");
  await write(
    path.join(plainRoot, "meta", "info.json"),
    '{"codebase_version":"v3.0"}',
  );
  await write(
    path.join(plainRoot, "data", "chunk-000", "file-000.parquet"),
    "PARQUET",
  );
  await write(
    path.join(plainRoot, "videos", "cam", "chunk-000", "file-000.mp4"),
    "MP4",
  );

  // Something outside the dataset that a traversal or a symlink must never reach.
  await write(path.join(tmp, "secret.txt"), "SECRET");

  cacheContainer = path.join(tmp, "datasets--org--name");
  cacheRoot = path.join(cacheContainer, "snapshots", "abc123");
  await write(
    path.join(cacheRoot, "meta", "info.json"),
    '{"codebase_version":"v3.0"}',
  );
  await write(path.join(cacheContainer, "blobs", "deadbeef"), "BLOB");
  // The real layout: every file is a symlink out of the snapshot into the sibling blobs/ dir.
  const cacheFile = path.join(
    cacheRoot,
    "data",
    "chunk-000",
    "file-000.parquet",
  );
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.symlink(
    path.relative(
      path.dirname(cacheFile),
      path.join(cacheContainer, "blobs", "deadbeef"),
    ),
    cacheFile,
  );
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("token round-trip", () => {
  test("encodes to a single URL-safe segment and decodes back", async () => {
    const token = encodeLocalToken(plainRoot);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await resolveLocalToken(token)).toBe(await fs.realpath(plainRoot));
  });

  test("garbage, non-path and non-dataset tokens resolve to null", async () => {
    expect(await resolveLocalToken("!!!not-base64!!!")).toBeNull();
    expect(
      await resolveLocalToken(encodeLocalToken("relative/not/absolute")),
    ).toBeNull();
    expect(
      await resolveLocalToken(encodeLocalToken(path.join(tmp, "secret.txt"))),
    ).toBeNull();
  });

  test("a directory without meta/info.json is not a dataset", async () => {
    expect(await resolveLocalDatasetRoot(tmp)).toBeNull();
    expect(
      await resolveLocalDatasetRoot(path.join(tmp, "does-not-exist")),
    ).toBeNull();
  });
});

describe("resolveDatasetFilePath", () => {
  test("serves a normal file inside the dataset", async () => {
    const r = await resolveDatasetFilePath(plainRoot, ["meta", "info.json"]);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.realPath).toBe(path.join(plainRoot, "meta", "info.json"));
  });

  test("rejects traversal, whatever the spelling", async () => {
    for (const segments of [
      ["meta", "..", "..", "secret.txt"],
      ["..", "secret.txt"],
      [".."],
      ["meta", ".."],
      ["meta", "", "info.json"],
      ["meta", "info.json", ".."],
    ]) {
      const r = await resolveDatasetFilePath(plainRoot, segments);
      expect(r.ok).toBe(false);
    }
  });

  test("rejects backslash and NUL segments", async () => {
    expect(
      (await resolveDatasetFilePath(plainRoot, ["meta\\..\\..\\secret.txt"]))
        .ok,
    ).toBe(false);
    expect(
      (await resolveDatasetFilePath(plainRoot, ["meta", "info\0.json"])).ok,
    ).toBe(false);
  });

  test("only serves meta/, data/ and videos/", async () => {
    expect(
      (await resolveDatasetFilePath(plainRoot, [".cache", "huggingface"])).ok,
    ).toBe(false);
    expect((await resolveDatasetFilePath(plainRoot, ["secret.txt"])).ok).toBe(
      false,
    );
    expect((await resolveDatasetFilePath(plainRoot, [])).ok).toBe(false);
  });

  test("refuses a symlink that escapes the dataset", async () => {
    const link = path.join(plainRoot, "meta", "leak.txt");
    await fs.symlink(path.join(tmp, "secret.txt"), link);
    const r = await resolveDatasetFilePath(plainRoot, ["meta", "leak.txt"]);
    expect(r.ok).toBe(false);

    const dirLink = path.join(plainRoot, "meta", "leakdir");
    await fs.symlink(tmp, dirLink);
    expect(
      (
        await resolveDatasetFilePath(plainRoot, [
          "meta",
          "leakdir",
          "secret.txt",
        ])
      ).ok,
    ).toBe(false);
  });

  test("follows the hub-cache blobs symlink, which lives outside the snapshot root", async () => {
    const r = await resolveDatasetFilePath(cacheRoot, [
      "data",
      "chunk-000",
      "file-000.parquet",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(await fs.realpath(r.realPath)).toBe(
        path.join(cacheContainer, "blobs", "deadbeef"),
      );
    }
  });

  test("does not follow the container symlink one level too far", async () => {
    // A symlink escaping the *container* (not just the snapshot) must still be refused.
    const link = path.join(cacheRoot, "data", "escape.txt");
    await fs.symlink(path.join(tmp, "secret.txt"), link);
    expect(
      (await resolveDatasetFilePath(cacheRoot, ["data", "escape.txt"])).ok,
    ).toBe(false);
  });
});

describe("allowedRealBases", () => {
  test("adds the container for a hub-cache snapshot", () => {
    expect(allowedRealBases(cacheRoot)).toEqual([cacheRoot, cacheContainer]);
  });

  test("stays at the root for a plain dataset", () => {
    expect(allowedRealBases(plainRoot)).toEqual([plainRoot]);
  });
});

describe("normalizeLocalPath", () => {
  test("expands ~ and makes paths absolute", () => {
    expect(normalizeLocalPath("~/datasets")).toBe(
      path.join(os.homedir(), "datasets"),
    );
    expect(normalizeLocalPath("~")).toBe(os.homedir());
    expect(normalizeLocalPath("relative/dir")).toBe(
      path.resolve("relative/dir"),
    );
  });
});

describe("localDatasetLabel", () => {
  test("prefers the org/name form from a hub-cache directory", () => {
    expect(localDatasetLabel(cacheRoot, [])).toBe("org/name");
  });

  test("falls back to the path relative to its scan root, then the basename", () => {
    expect(localDatasetLabel(plainRoot, [tmp])).toBe("plain");
    expect(localDatasetLabel("/somewhere/else/myproj", [tmp])).toBe("myproj");
  });
});

describe("isLocalDatasetsEnabled", () => {
  test("is on outside production and off in a production build unless forced", () => {
    const original = { ...process.env };
    try {
      delete process.env.LOCAL_DATASETS;
      process.env.NODE_ENV = "development";
      expect(isLocalDatasetsEnabled()).toBe(true);

      process.env.NODE_ENV = "production";
      expect(isLocalDatasetsEnabled()).toBe(false);

      process.env.LOCAL_DATASETS = "1";
      expect(isLocalDatasetsEnabled()).toBe(true);

      process.env.NODE_ENV = "development";
      process.env.LOCAL_DATASETS = "0";
      expect(isLocalDatasetsEnabled()).toBe(false);
    } finally {
      process.env = original;
    }
  });
});
