import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card, Grid, Section } from "./layout";
import { renderUi } from "./test-utils";

describe("layout primitives", () => {
  it("label a section and a card by their headings at the given level", () => {
    renderUi(
      <Section title="Buchungen" actions={<button type="button">{"Buchen"}</button>}>
        <Grid columns={2}>
          <Card title="Details" level={3} description="Wann und wo">
            <p>{"Inhalt"}</p>
          </Card>
        </Grid>
      </Section>,
    );
    const section = screen.getByRole("region", { name: "Buchungen" });
    expect(screen.getByRole("heading", { name: "Buchungen", level: 2 })).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Details" });
    expect(section).toContainElement(card);
    expect(screen.getByRole("heading", { name: "Details", level: 3 })).toBeInTheDocument();
    expect(card.closest(".tp-grid")).toHaveClass("tp-grid--2");
  });

  it("skips the two-column step with collapse wide", () => {
    renderUi(
      <Grid columns={3} collapse="wide">
        <p>{"Spalte"}</p>
      </Grid>,
    );
    expect(screen.getByText("Spalte").parentElement).toHaveClass(
      "tp-grid",
      "tp-grid--3",
      "tp-grid--collapse-wide",
    );
  });
});
