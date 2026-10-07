// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorBoundary } from "react-error-boundary";

function Boom(): never {
  throw new Error("boom");
}

afterEach(() => {
  cleanup();
});

test("renders the fallback instead of crashing when a child throws", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onError = vi.fn();

  render(
    <ErrorBoundary fallback={<p>fallback shown</p>} onError={onError}>
      <Boom />
    </ErrorBoundary>,
  );

  expect(screen.getByText("fallback shown")).toBeInTheDocument();
  expect(onError).toHaveBeenCalledOnce();

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
