import { useEffect, useState } from "react";
import { faker } from "@faker-js/faker";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// For demo purposes. In a real app, you'd have real user data.
const NAME = getOrSetFakeName();

export default function App() {
  const messages = useQuery(api.chat.getMessages);
  const getOrCreateUser = useMutation(api.chat.getOrCreateUser);
  const sendMessage = useMutation(api.chat.sendMessage);
  const [newMessageText, setNewMessageText] = useState("");
  const [userId, setUserId] = useState<Id<"users"> | null>(null);
  const [userIdError, setUserIdError] = useState(false);
  const [sendError, setSendError] = useState(false);

  useEffect(() => {
    getOrCreateUser({ name: NAME })
      .then(setUserId)
      .catch(() => setUserIdError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Make sure scrollTo works on button click in Chrome
    setTimeout(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }, 0);
  }, [messages]);


  return (
    <main className="chat">
      <header>
        <h1>Convex Chat</h1>
        <p>
          Connected as <strong>{NAME}</strong>
        </p>
        {userIdError && <p>Couldn't connect — try reloading.</p>}
      </header>
      {messages?.map((message) => (
        <article
          key={message._id}
          className={message.user === userId ? "message-mine" : ""}
        >
          <div>{message.name}</div>

          <p>{message.body}</p>
        </article>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!userId) {
            return;
          }
          try {
            await sendMessage({ user: userId, body: newMessageText });
            setNewMessageText("");
            setSendError(false);
          } catch {
            setSendError(true);
          }
        }}
      >
        <input
          value={newMessageText}
          onChange={async (e) => {
            const text = e.target.value;
            setNewMessageText(text);
          }}
          placeholder="Write a message…"
          autoFocus
        />
        <button type="submit" disabled={!newMessageText || !userId}>
          Send
        </button>
      </form>
      {sendError && <p>Message failed to send — try again.</p>}
    </main>
  );
}

function getOrSetFakeName() {
  const NAME_KEY = "tutorial_name";
  const name = sessionStorage.getItem(NAME_KEY);
  if (!name) {
    const newName = faker.person.firstName();
    sessionStorage.setItem(NAME_KEY, newName);
    return newName;
  }
  return name;
}
