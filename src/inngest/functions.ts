import { inngest } from "./client";

export const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "test/hello.world" },
  async ({ event, step }) => {
    //imagine that this is transcript step
    await step.sleep
    ("wait-a-moment", "10s");
    //imagine that this is summary step
    await step.sleep
    ("wait-a-moment", "5s");
    return { message: `Hello ${event.data.email}!` };
  },
);