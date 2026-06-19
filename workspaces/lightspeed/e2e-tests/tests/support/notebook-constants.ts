import path from "path";

export const NOTEBOOK_UNTITLED_GRID_NAME = "Untitled Notebook";
export const NOTEBOOK_EDITOR_URL_RE = /\/lightspeed\/notebooks\/[^/]+$/;
export const NOTEBOOK_SESSION_MAX_DOCUMENTS = 10;

const uploadFixturesDir = path.join(import.meta.dirname, "../fixtures/uploads");

const CAP_TEST_UPLOAD_FILES = [
  "de.upload1.json",
  "de.upload2.json",
  "en.upload1.json",
  "en.upload2.json",
  "es.upload1.json",
  "es.upload2.json",
  "fr.upload1.json",
  "fr.upload2.json",
  "it.upload1.json",
  "it.upload2.json",
  "ja.upload1.json",
] as const;

export function notebookElevenFileStagingPaths(): string[] {
  return CAP_TEST_UPLOAD_FILES.map((name) =>
    path.join(uploadFixturesDir, name),
  );
}

export function notebookUnsupportedTypeFixturePath(): string {
  return path.join(import.meta.dirname, "notebook-constants.ts");
}

export function localeNotebookUploadPath(fileName = "en.upload1.json"): {
  absolutePath: string;
  fileName: string;
} {
  return {
    absolutePath: path.join(uploadFixturesDir, fileName),
    fileName,
  };
}
