import { describe, it, expect } from "vitest";
import { loginToPerson } from "../src/people";

describe("loginToPerson", () => {
  it("maps the four known logins to roadmap first names", () => {
    expect(loginToPerson("AndresL230")).toBe("Andres");
    expect(loginToPerson("Jose-Gael-Cruz-Lopez")).toBe("Jose");
    expect(loginToPerson("lpcooper-arch")).toBe("Luke");
    expect(loginToPerson("Darkest-Teddy")).toBe("Jack");
  });
  it("returns null for an unknown login", () => {
    expect(loginToPerson("octo-stranger")).toBeNull();
  });
});
