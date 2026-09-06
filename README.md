# Convex tutorial

You're just a few minutes away from having a chat app powered by Convex.

Follow the tutorial at
[docs.convex.dev/tutorial](https://docs.convex.dev/tutorial) for instructions.

## Security notice

This repository's tutorial examples are intentionally anonymous. Their public
Convex functions allow any connected client to read and write shared example
data, and the chat example accepts a caller-supplied user ID to choose the
displayed sender. This keeps the tutorial focused on the data flow; it is not
a production authorization model.

Before deploying an app based on these examples, add authentication and derive
the caller's identity and resource ownership on the server rather than trusting
client-supplied identity values.
