// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

function Boom(): never {
  throw new Error("boom");
}

afterEach(() => {
  cleanup();
});

test("renders the fallback instead of crashing when a child throws", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  render(
    <ErrorBoundary fallback={<p>fallback shown</p>}>
      <Boom />
    </ErrorBoundary>,
  );

  expect(screen.getByText("fallback shown")).toBeInTheDocument();

  vi.restoreAllMocks();
});

test("renders children normally when nothing throws", () => {
  render(
    <ErrorBoundary fallback={<p>fallback shown</p>}>
      <p>all good</p>
    </ErrorBoundary>,
  );

  expect(screen.getByText("all good")).toBeInTheDocument();
  expect(screen.queryByText("fallback shown")).not.toBeInTheDocument();
});
