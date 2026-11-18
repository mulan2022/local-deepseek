CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

Your task is to create a detailed summary of the conversation so far, paying close attention to
the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural
decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your
thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section
   thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user
     told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element
   thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Persistent Context and Preferences: List enduring background information, user preferences,
   communication style, boundaries, and other details explicitly stated by the user that remain
   relevant to future conversation. Clearly distinguish durable information from temporary states.
   Do not turn a temporary emotion, event, or situation into a permanent characteristic.
3. Files and Code Sections: List every file uploaded by the user, preserving its exact filename
   and including a short description of its content and relevance to the conversation. Include
   images, screenshots, documents, and other attachments. Do not omit an uploaded file merely
   because it has no text content. Do not include full file contents unless they are essential
   for understanding the conversation.
4. User Experiences and Outcomes: List meaningful events the user experienced and their outcomes.
   Preserve information that may affect future conversation. Merge repeated descriptions of the
   same event and keep the latest known outcome.
5. All user messages: Output only the exact placeholder {{ALL_USER_MESSAGES_VERBATIM}} for this
   section. The application will replace this placeholder with all original user messages
   programmatically. Do NOT summarize, paraphrase, generate, reorder, or omit user messages yourself.
6. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
7. Current Work: Describe in detail precisely what was being worked on immediately before this
   summary request, paying special attention to the most recent messages from both user and
   assistant. Include file names and code snippets where applicable.
8. Optional Next Step: List the next step that you will take that is related to the most recent
   work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's
   most recent explicit requests, and the task you were working on immediately before this
   summary request. If there is a next step, include direct quotes from the most recent
   conversation showing exactly what task you were working on and where you left off. This should
   be verbatim to prevent any drift in task interpretation.

Example output structure:

<analysis>
[Chronological, section-by-section reasoning — this is a scratchpad and will be discarded.]
</analysis>

<summary>
1. Primary Request and Intent:
   ...
2. Persistent Context and Preferences:
   ...
3. Files and Code Sections:
   ...
4. User Experiences and Outcomes:
   ...
5. All user messages:
   {{ALL_USER_MESSAGES_VERBATIM}}
6. Pending Tasks:
   ...
7. Current Work:
   ...
8. Optional Next Step:
   ...
</summary>

There may be additional summarization instructions provided below.
If so, remember to follow these instructions when creating the above summary.

IMPORTANT: Do NOT use any tools. You MUST respond with ONLY the <analysis> and <summary> blocks
as your text output.
