// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mockUseQuery = vi.fn();
const getOrCreateUserMutation = vi.fn();
const sendMessageMutation = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (ref: string) => {
    if (ref === "getOrCreateUser") return getOrCreateUserMutation;
    if (ref === "sendMessage") return sendMessageMutation;
    throw new Error(`unexpected useMutation ref: ${ref}`);
  },
}));

vi.mock("../convex/_generated/api", () => ({
  api: {
    chat: {
      getMessages: "getMessages",
      getOrCreateUser: "getOrCreateUser",
      sendMessage: "sendMessage",
    },
  },
}));

const { default: App } = await import("./App");

beforeEach(() => {
  sessionStorage.clear();
  mockUseQuery.mockReset();
  getOrCreateUserMutation.mockReset();
  sendMessageMutation.mockReset();
  mockUseQuery.mockImplementation((ref: string) => {
    if (ref === "getMessages") return [];
    throw new Error(`unexpected useQuery ref: ${ref}`);
  });
});

afterEach(() => {
  cleanup();
});

test("mount resolves getOrCreateUser and enables send", async () => {
  getOrCreateUserMutation.mockResolvedValue("user123");
  render(<App />);

  const input = screen.getByPlaceholderText("Write a message…");
  fireEvent.change(input, { target: { value: "hello" } });

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
  });
});

test("mount rejection shows the error banner and keeps send disabled", async () => {
  getOrCreateUserMutation.mockRejectedValue(new Error("network down"));
  render(<App />);

  await waitFor(() => {
    expect(screen.getByText("Couldn't connect — try reloading.")).toBeInTheDocument();
  });

  const input = screen.getByPlaceholderText("Write a message…");
  fireEvent.change(input, { target: { value: "hello" } });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("submitting while userId is still null is a no-op", async () => {
  getOrCreateUserMutation.mockReturnValue(new Promise(() => {})); // never resolves
  const { container } = render(<App />);

  const input = screen.getByPlaceholderText("Write a message…");
  fireEvent.change(input, { target: { value: "hello" } });
  fireEvent.submit(container.querySelector("form")!);

  expect(sendMessageMutation).not.toHaveBeenCalled();
});

test("a rejected sendMessage shows the failure banner and keeps the draft text", async () => {
  getOrCreateUserMutation.mockResolvedValue("user123");
  sendMessageMutation.mockRejectedValue(new Error("insert failed"));
  render(<App />);

  const input = screen.getByPlaceholderText("Write a message…") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "hello" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(screen.getByText("Message failed to send — try again.")).toBeInTheDocument();
  });
  expect(input.value).toBe("hello");
});

test("a successful sendMessage clears the input and clears a prior send error", async () => {
  getOrCreateUserMutation.mockResolvedValue("user123");
  sendMessageMutation.mockRejectedValueOnce(new Error("insert failed"));
  sendMessageMutation.mockResolvedValueOnce(undefined);
  render(<App />);

  const input = screen.getByPlaceholderText("Write a message…") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "hello" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    expect(screen.getByText("Message failed to send — try again.")).toBeInTheDocument();
  });

  fireEvent.change(input, { target: { value: "hello again" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(screen.queryByText("Message failed to send — try again.")).not.toBeInTheDocument();
  });
  expect(input.value).toBe("");
});

test("renders without crashing while getMessages is still loading (undefined)", async () => {
  getOrCreateUserMutation.mockResolvedValue("user123");
  mockUseQuery.mockImplementation((ref: string) => {
    if (ref === "getMessages") return undefined;
    throw new Error(`unexpected useQuery ref: ${ref}`);
  });

  expect(() => render(<App />)).not.toThrow();
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
});

test("message-mine is applied by id equality, not by display name", async () => {
  getOrCreateUserMutation.mockResolvedValue("user123");
  mockUseQuery.mockImplementation((ref: string) => {
    if (ref === "getMessages") {
      return [
        { _id: "m1", user: "user123", name: "Alice", body: "mine" },
        { _id: "m2", user: "user456", name: "Bob", body: "not mine" },
      ];
    }
    throw new Error(`unexpected useQuery ref: ${ref}`);
  });
  render(<App />);

  await waitFor(() => {
    expect(screen.getByText("mine").closest("article")).toHaveClass("message-mine");
  });
  expect(screen.getByText("not mine").closest("article")).not.toHaveClass("message-mine");
});
