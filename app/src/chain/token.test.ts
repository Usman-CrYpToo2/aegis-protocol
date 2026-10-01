import { describe, expect, it } from "vitest";
import { safeDocsUrl } from "./token";

describe("safeDocsUrl", () => {
  it("keeps a well-formed https link", () => {
    expect(safeDocsUrl("https://issuer.example/offering.pdf")).toBe("https://issuer.example/offering.pdf");
  });
  it("drops anything that isn't https, and empty values", () => {
    for (const v of ["", "http://issuer.example", "javascript:alert(1)", "data:text/html,x", "https://localhost/x", "not a url"]) expect(safeDocsUrl(v)).toBeNull();
  });
});
