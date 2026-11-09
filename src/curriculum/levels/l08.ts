import type { Level } from "../types";

export const L8: Level = {
  number: 8,
  title: "AI security",
  short: "Security",
  phase: "trust",
  summary:
    "Defend LLM, RAG and agent systems against attacks specific to models, unsafe actions and data leaks, and recognise the governance and regulatory duties that come with shipping AI.",
  interviewWeight: 5,
  interviewNote:
    "Usually one question, most often about prompt injection, and it rarely decides the outcome. Solid basics are enough unless the role is security-focused.",
  jobWeight: 7,
  jobNote:
    "Any system with tools or private data is exposed to injection and leaks, and one incident can be very expensive. Day-to-day effort is moderate unless you work in a regulated industry.",
  assumes: [7],
  modules: [
    {
      id: "8.1",
      title: "Threat modelling AI apps",
      sessions: 1,
      topics: [
        { title: "A new attack surface", detail: "See what changes when a model reads untrusted content, touches private data, calls tools and takes actions." },
        { title: "Trust boundaries", detail: "Mark where trust changes across prompts, retrieved data, tools, memory, outputs and external systems." },
        { title: "Output is untrusted", detail: "Treat what the model produces, including tool calls, as untrusted until checked." },
      ],
      outcome: "You can threat-model an LLM app before choosing defences.",
    },
    {
      id: "8.2",
      title: "Prompt injection and data exfiltration",
      sessions: 3,
      topics: [
        { title: "Direct and indirect", detail: "Separate injection typed by the user from instructions hidden in documents, pages, emails, chunks or tool output." },
        { title: "What attackers aim for", detail: "Overriding instructions, steering tools, leaking private context and hijacking the agent's goal." },
        { title: "The dangerous combination", detail: "Untrusted input plus access to private data or powerful tools plus a way to send data out." },
        { title: "Layered defences", detail: "Separate instructions from data, apply least privilege, check authorisation in code, restrict tools, require confirmation and validate output." },
        { title: "Why a warning prompt isn't a boundary", detail: "Understand why telling the model to ignore malicious instructions can't be relied on." },
      ],
      outcome: "You can build apps that stay safe even when hostile instructions reach the model.",
    },
    {
      id: "8.3",
      title: "Jailbreaks, guardrails and moderation",
      sessions: 2,
      topics: [
        { title: "Jailbreak vs injection", detail: "Tell the two apart and recognise common jailbreak families." },
        { title: "Input and output checks", detail: "Add moderation, validation and policy checks on both sides of the model." },
        { title: "Why one layer fails", detail: "Know the limits of model-based guardrails and why you stack several." },
        { title: "Testing with hostile input", detail: "Test guardrails with adversarial and obfuscated input, not just normal traffic." },
      ],
      outcome: "You can reduce unsafe behaviour without leaning on a single defensive prompt.",
    },
    {
      id: "8.4",
      title: "Securing agents and tools",
      sessions: 2,
      topics: [
        { title: "Least privilege", detail: "Give an agent only the tools and permissions its task needs." },
        { title: "Reading vs acting", detail: "Separate read-only tools from ones that send, change, delete, buy or execute." },
        { title: "Checks outside the model", detail: "Validate tool choice, arguments, permissions and results in code." },
        { title: "Approval for irreversible steps", detail: "Require a person to confirm sensitive or one-way actions." },
        { title: "Runaway limits", detail: "Cap steps, runtime, cost and tool use." },
        { title: "Generated code and queries", detail: "Sandbox generated code and treat generated SQL, commands, URLs and API calls as untrusted." },
      ],
      outcome: "You can give agents useful autonomy without unrestricted control of real systems.",
    },
    {
      id: "8.5",
      title: "Securing RAG and knowledge",
      sessions: 1,
      topics: [
        { title: "Documents are data", detail: "Treat retrieved text as untrusted content, never as instructions." },
        { title: "Poisoned corpora", detail: "Understand how planted documents can carry hidden instructions or false facts." },
        { title: "Document permissions", detail: "Enforce access control at retrieval time so users only see what they're allowed to." },
        { title: "Tenant isolation", detail: "Prevent leaks between users or customers in vector stores and memory." },
        { title: "Provenance", detail: "Keep source and origin attached to every retrieved chunk." },
      ],
      outcome: "You can secure the knowledge layer under a RAG app.",
    },
    {
      id: "8.6",
      title: "Privacy, PII and secrets",
      sessions: 2,
      topics: [
        { title: "Spotting sensitive data", detail: "Identify PII, credentials, financial data, private conversations and confidential business data." },
        { title: "Redact and minimise", detail: "Detect, mask or drop sensitive data before it reaches a model where you can." },
        { title: "Keeping it out of logs", detail: "Find every place an AI system quietly copies user data (traces, logs, memory, indexes, test sets) and keep secrets and personal data out of them." },
        { title: "Retention and residency", detail: "Understand retention, deletion, data location, access control and model-provider terms." },
        { title: "Regulated deployments", detail: "Private network paths to the model, no public egress, and zero-retention or no-training agreements." },
        { title: "Secrets stay out of prompts", detail: "Keep API keys and credentials away from the model entirely." },
      ],
      outcome: "You can minimise how much sensitive data passes through an AI system.",
    },
    {
      id: "8.7",
      title: "Red teaming",
      sessions: 2,
      topics: [
        { title: "Adversarial test suites", detail: "Turn known attack classes into repeatable test cases that run on every change, from hostile documents to attempts to misuse tools or leak data." },
        { title: "Attacking through the corpus", detail: "Plant test documents in a RAG index and see whether they change behaviour." },
        { title: "Attacking through tools", detail: "Try to push an agent past its permissions, into misusing tools, leaking secrets or looping." },
        { title: "Findings become tests", detail: "Turn every discovered weakness into a permanent regression test." },
        { title: "Security metrics", detail: "Track attack success rate, leak rate and unsafe-action rate." },
      ],
      outcome: "You can test defences adversarially instead of assuming they work.",
    },
    {
      id: "8.8",
      title: "Responsible AI and governance",
      sessions: 1,
      topics: [
        { title: "Core concerns", detail: "Hallucination, bias and fairness, transparency, accountability and human oversight." },
        { title: "Documenting a system", detail: "Write down intended use, limits, risks, evaluations and human controls." },
        { title: "Regulation", detail: "Know the practical impact of laws such as the EU AI Act and India's DPDP Act." },
        { title: "Audit trails", detail: "Keep model and prompt versions, logs, approvals and eval records." },
      ],
      outcome: "You can recognise when an AI app creates governance or compliance obligations.",
    },
    { id: "8.9", title: "Capstone: red-team and harden an agentic RAG app", sessions: 1, topics: [], outcome: "You have an AI app that stays safe even when the model is fooled or makes a bad call.", projectId: "red-team-agentic-rag" },
  ],
  projects: [
    {
      id: "red-team-agentic-rag",
      title: "Red-team and harden an agentic RAG app",
      summary: "Attack an app you built in an earlier level, fix what breaks with layered defences, and lock the fixes in with security regression tests.",
      steps: [
        { title: "Threat model", detail: "Take your agentic RAG or Level 5 agent app, draw its trust boundaries, and list what an attacker could reach: data, tools and outbound channels." },
        { title: "Attack it", detail: "Write test cases for direct and indirect injection, poisoned documents, jailbreaks, private-data extraction, tool misuse and unauthorised actions, and record the attack success rate." },
        { title: "Harden tools", detail: "Apply least-privilege tools, permission checks in code, approval gates for consequential actions and sandboxing for any code execution." },
        { title: "Harden data", detail: "Add input and output guardrails, document-level access control, PII redaction and keep secrets out of prompts and logs." },
        { title: "Lock it in", detail: "Turn every successful attack into a regression test that runs in CI, and re-run the full suite to report before and after rates." },
      ],
      deliverable: "A repo with the hardened app, a threat model diagram, the adversarial test suite in CI, and a README with before/after attack success and leak rates.",
      stretch: ["Run an automated red-teaming tool such as garak or PyRIT against it and triage the findings.", "Write a one-page system card covering intended use, limits and residual risks."],
    },
  ],
};
