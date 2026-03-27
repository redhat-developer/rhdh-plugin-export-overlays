import { type Page } from "@red-hat-developer-hub/e2e-test-utils/test";

export class ImageRegistry {
  static getAllCellsIdentifier() {
    const tagText = /^((pr|next)-.*|\d+\.\d+.*)$/i;
    const lastModifiedDate =
      /^[A-Za-z]{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM)$/; // Example: Jan 21, 2025, 7:54 PM
    const size = /^\d+(\.\d+)?\s?(GB|MB)$/; // Example: 1.16 GB or 512 MB
    const expires =
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}, \d{1,2}:\d{2} [APM]{2}$/; // Example: Feb 2, 2026 4:01 PM

    const manifest = /^sha256/;
    const securityScan =
      /^(?:Critical:\s\d+)?(?:,\s)?(?:High:\s\d+)?(?:,\s)?(?:Medium:\s\d+)?(?:,\s)?(?:Low:\s\d+)?(?:,\s)?(?:Unknown:\s\d+)?$|^Queued$/i;
    return [tagText, lastModifiedDate, securityScan, size, expires, manifest];
  }

  static getAllGridColumnsText() {
    return [
      "Tag",
      "Last Modified",
      "Security Scan",
      "Size",
      "Expires",
      "Manifest",
    ];
  }

  static securityScanRegex() {
    const securityScan = ["Critical", "High", "Medium", "Low", "Unknown"].map(
      (i) => `(${i}:\\s\\d+[^\\w]*)`,
    );
    return new RegExp(
      `^(Passed|unsupported|Queued|Medium|Low|(?:${securityScan.join("|")})+)$`,
      "i", // Case-insensitive flag to match "Unsupported" or "unsupported"
    );
  }

  static async getScanCell(page: Page) {
    const locator = page
      .getByRole("cell")
      .filter({ hasText: this.securityScanRegex() });
    await locator.first().waitFor();
    return locator.first();
  }
}
