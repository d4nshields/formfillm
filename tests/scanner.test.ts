// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { scanFields } from "../src/content/scanner.js";

function setBody(html: string) {
  document.body.innerHTML = html;
  // jsdom reports zero rects; force visibility by stubbing getBoundingClientRect.
  for (const el of Array.from(document.querySelectorAll("*"))) {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON() {} }) as DOMRect;
  }
}

describe("scanFields", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("extracts labels and metadata without field values", () => {
    setBody(`
      <form name="signup">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" autocomplete="email" value="leak@secret.com" required />
        <label for="pw">Password</label>
        <input id="pw" name="pw" type="password" value="hunter2" />
        <label for="lang">Language</label>
        <select id="lang"><option value="">Choose</option><option value="en">English</option></select>
      </form>
    `);
    const { fields } = scanFields();
    const email = fields.find((f) => f.domId === "email")!;
    expect(email).toBeDefined();
    expect(email.labelText).toBe("Email address");
    expect(email.inputType).toBe("email");
    expect(email.required).toBe(true);
    expect(email.hasValue).toBe(true);
    // Critically: the actual value must NOT appear anywhere in the metadata.
    expect(JSON.stringify(email)).not.toContain("leak@secret.com");

    // Password field is detected (so it can be flagged), never its value.
    const pw = fields.find((f) => f.domId === "pw")!;
    expect(pw.inputType).toBe("password");
    expect(JSON.stringify(pw)).not.toContain("hunter2");

    // Select options are captured.
    const lang = fields.find((f) => f.domId === "lang")!;
    expect(lang.kind).toBe("select");
    expect(lang.options?.some((o) => o.label === "English")).toBe(true);
  });

  it("groups radios by name into one field", () => {
    setBody(`
      <fieldset>
        <legend>Contact preference</legend>
        <label><input type="radio" name="pref" value="email" /> Email</label>
        <label><input type="radio" name="pref" value="sms" /> SMS</label>
      </fieldset>
    `);
    const { fields } = scanFields();
    const radios = fields.filter((f) => f.kind === "radio");
    expect(radios).toHaveLength(1);
    expect(radios[0]!.options?.length).toBe(2);
  });

  it("assigns unique field ids and a registry entry per field", () => {
    setBody(`<input type="text" name="a" /><input type="text" name="b" />`);
    const { fields, refs } = scanFields();
    const ids = fields.map((f) => f.fieldId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(refs.has(id)).toBe(true);
  });
});
