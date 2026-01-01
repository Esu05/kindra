import { openai, createAgent, createTool, createNetwork, type Tool, type Message, createState } from "@inngest/agent-kit";
import { Sandbox } from "@e2b/code-interpreter"
import { inngest } from "./client";
import { getSandbox, lastAssistantTextMessageContent } from "./utils";
import z from "zod";
import { PROMPT, FRAGMENT_TITLE_PROMPT, RESPONSE_PROMPT } from "@/prompt";
import { prisma } from "@/lib/db";
import { SANDBOX_TIMEOUT } from "./types";
import { refundCredit } from "@/lib/usage"; // Import refund function

interface AgentState {
  summary: string;
  files: { [path: string]: string };
}

export const codeAgentFunction = inngest.createFunction(
  { 
    id: "code-agent",
    retries: 0, // Don't retry automatically
  },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    let sandboxId: string | null = null;

    try {
      sandboxId = await step.run("get-sandbox-id", async () => {
        const sandbox = await Sandbox.create("kindra-nextjs-test-2");
        await sandbox.setTimeout(SANDBOX_TIMEOUT);
        return sandbox.sandboxId;
      });

      const previousMessages = await step.run("get-previous-messages", async () => {
        const formattedMessages: Message[] = [];

        const messages = await prisma.message.findMany({
          where: {
            projectId: event.data.projectId,
          },
          orderBy: {
            createdAt: "desc"
          },
          take: 5,
        });

        for (const message of messages) {
          formattedMessages.push({
            type: "text",
            role: message.role === "ASSISTANT" ? "assistant" : "user",
            content: message.content,
          });
        }
        return formattedMessages.reverse();
      });

      const state = createState<AgentState>(
        {
          summary: "",
          files: {},
        },
        {
          messages: previousMessages,
        },
      );

      const codeAgent = createAgent<AgentState>({
        name: "code-agent",
        description: "An expert coding agent",
        system: PROMPT,
        model: openai({
          model: "mistralai/devstral-2512:free",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: process.env.OPENROUTER_API_KEY,
          headers: {
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "Kindra Lovable Clone",
          },
          temperature: 0.1,
        } as any),
        tools: [
          createTool({
            name: "terminal",
            description: "Use terminal to run commands",
            parameters: z.object({
              command: z.string(),
            }),
            handler: async ({ command }, { step }) => {
              return await step?.run("terminal", async () => {
                const buffers = { stdout: "", stderr: "" };
                try {
                  const sandbox = await getSandbox(sandboxId!);
                  const result = await sandbox.commands.run(command, {
                    onStdout: (data: string) => {
                      buffers.stdout += data;
                    },
                    onStderr: (data: string) => {
                      buffers.stderr += data;
                    }
                  });
                  return result.stdout;
                } catch (e) {
                  console.error(`Command failed: ${e} \nstdout: ${buffers.stdout}\nstderr: ${buffers.stderr}`);
                  return `Command failed: ${e} \nstdout: ${buffers.stdout}\nstderr: ${buffers.stderr}`;
                }
              });
            },
          }),
          createTool({
            name: "createOrUpdateFiles",
            description: "Create or update files in the sandbox",
            parameters: z.object({
              files: z.array(
                z.object({
                  path: z.string(),
                  content: z.string(),
                }),
              ),
            }),
            handler: async ({ files }, { step, network }: Tool.Options<AgentState>) => {
              const newFiles = await step?.run("createOrUpdateFiles", async () => {
                try {
                  const updatedFiles = network.state.data.files || {};
                  const sandbox = await getSandbox(sandboxId!);
                  for (const file of files) {
                    await sandbox.files.write(file.path, file.content);
                    updatedFiles[file.path] = file.content;
                  }
                  return updatedFiles;
                } catch (e) {
                  console.error("Error creating/updating files:", e);
                  return "Error:" + e;
                }
              });
              if (typeof newFiles === "object") {
                network.state.data.files = newFiles;
              }
            }
          }),
          createTool({
            name: "readFiles",
            description: "Read files from the sandbox",
            parameters: z.object({
              files: z.array(z.string()),
            }),
            handler: async ({ files }, { step }) => {
              return await step?.run("readFiles", async () => {
                try {
                  const sandbox = await getSandbox(sandboxId!);
                  const contents = [];
                  for (const file of files) {
                    const content = await sandbox.files.read(file);
                    contents.push({ path: file, content });
                  }
                  return JSON.stringify(contents);
                } catch (e) {
                  console.error("Error reading files:", e);
                  return "Error:" + e;
                }
              });
            }
          })
        ],
        lifecycle: {
          onResponse: async ({ result, network }) => {
            const lastAssistantMessageText = lastAssistantTextMessageContent(result);

            if (lastAssistantMessageText && network) {
              if (lastAssistantMessageText.includes("<task_summary>")) {
                network.state.data.summary = lastAssistantMessageText;
              }
            }
            return result;
          },
        }
      });

      const network = createNetwork<AgentState>({
        name: "coding-agent-network",
        agents: [codeAgent],
        maxIter: 15,
        defaultState: state,
        router: async ({ network }) => {
          const summary = network.state.data.summary;
          if (summary) {
            return;
          }
          return codeAgent;
        },
      });

      const result = await network.run(event.data.value, { state });

      // Check if generation failed
      const isError = !result.state.data.summary ||
        Object.keys(result.state.data.files || {}).length === 0;

      if (isError) {
        console.error("Code generation failed - no summary or files generated");

        // Refund the credit
        await step.run("refund-credit", async () => {
          try {
            await refundCredit(event.data.userId);
            console.log("Credit refunded successfully");
          } catch (error) {
            console.error("Error refunding credit:", error);
          }
        });

        // Save error message
        await step.run("save-error-result", async () => {
          return await prisma.message.create({
            data: {
              projectId: event.data.projectId,
              content: "Sorry, I failed to generate a response. Please try again with a more specific prompt or simpler request.",
              role: "ASSISTANT",
              type: "ERROR",
            },
          });
        });

        // Clean up sandbox
        if (sandboxId) {
          try {
            const sandbox = await getSandbox(sandboxId);
          } catch (e) {
            console.error("Error closing sandbox:", e);
          }
        }

        // Return error state instead of throwing
        return {
          error: true,
          message: "Failed to generate code",
        };
      }

      const fragmentTitleGenerator = createAgent({
        name: "fragment-title-generator",
        description: "An expert fragment title generator",
        system: FRAGMENT_TITLE_PROMPT,
        model: openai({
          model: "deepseek/deepseek-r1-0528:free",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: process.env.OPENROUTER_API_KEY,
        }),
      });

      const responseGenerator = createAgent({
        name: "response-generator",
        description: "An expert response generator",
        system: RESPONSE_PROMPT,
        model: openai({
          model: "mistralai/mistral-7b-instruct:free",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: process.env.OPENROUTER_API_KEY,
        })
      });

      const { output: fragmentTitleOutput } = await fragmentTitleGenerator.run(result.state.data.summary);
      const { output: responseOutput } = await responseGenerator.run(result.state.data.summary);

      const generateFragmentTitle = () => {
        if (fragmentTitleOutput[0]?.type !== "text") {
          return "Fragment";
        }

        if (Array.isArray(fragmentTitleOutput[0].content)) {
          return fragmentTitleOutput[0].content.map((txt) => txt).join("");
        } else {
          return fragmentTitleOutput[0].content;
        }
      };

      const generateResponse = () => {
        if (responseOutput[0]?.type !== "text") {
          return "Here you go!";
        }

        if (Array.isArray(responseOutput[0].content)) {
          return responseOutput[0].content.map((txt) => txt).join("");
        } else {
          return responseOutput[0].content;
        }
      };

      const sandboxUrl = await step.run("get-sandbox-url", async () => {
        const sandbox = await getSandbox(sandboxId!);
        const host = sandbox.getHost(3000);
        return `https://${host}`;
      });

      await step.run("save-success-result", async () => {
        return await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: generateResponse(),
            role: "ASSISTANT",
            type: "RESULT",
            fragment: {
              create: {
                sandboxUrl: sandboxUrl,
                title: generateFragmentTitle(),
                files: result.state.data.files,
              },
            },
          },
        });
      });

      return {
        success: true,
        url: sandboxUrl,
        title: generateFragmentTitle(),
        files: result.state.data.files,
        summary: result.state.data.summary,
      };

    } catch (error) {
      console.error("Code agent function error:", error);

      // Refund credit on any error
      await step.run("refund-credit-on-error", async () => {
        try {
          await refundCredit(event.data.userId);
          console.log("Credit refunded after error");
        } catch (refundError) {
          console.error("Error refunding credit:", refundError);
        }
      });

      // Save error message
      await step.run("save-error-message", async () => {
        const existingErrorMessage = await prisma.message.findFirst({
          where: {
            projectId: event.data.projectId,
            type: "ERROR",
            createdAt: {
              gte: new Date(Date.now() - 60000), // Within last minute
            },
          },
        });

        if (!existingErrorMessage) {
          return await prisma.message.create({
            data: {
              projectId: event.data.projectId,
              content: "Sorry, an unexpected error occurred. Please try again.",
              role: "ASSISTANT",
              type: "ERROR",
            },
          });
        }
      });

      // Clean up sandbox
      if (sandboxId) {
        try {
          const sandbox = await getSandbox(sandboxId);
        } catch (e) {
          console.error("Error closing sandbox:", e);
        }
      }

      return {
        error: true,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
);