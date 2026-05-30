import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { VoiceGraphState } from '../types/voice-turn.types';

export const VoiceStateAnnotation = Annotation.Root({
  callSessionId: Annotation<string>,
  utterance: Annotation<string>,
  history: Annotation<VoiceGraphState['history']>,
  context: Annotation<VoiceGraphState['context']>,
  intent: Annotation<VoiceGraphState['intent']>,
  intentConfidence: Annotation<number>,
  immediateFiller: Annotation<string>,
  agentResults: Annotation<VoiceGraphState['agentResults']>,
  reply: Annotation<string>,
  modelUsed: Annotation<string>,
  escalateToComplexModel: Annotation<boolean>,
  memoryPatch: Annotation<Record<string, unknown>>,
});

export type VoiceGraphNode = (
  state: VoiceGraphState,
) => Promise<Partial<VoiceGraphState>>;

export type VoiceOrchestrationGraphDeps = {
  router: VoiceGraphNode;
  conversationFiller: VoiceGraphNode;
  parallelAgents: VoiceGraphNode;
  synthesize: VoiceGraphNode;
};

export function buildVoiceOrchestrationGraph(deps: VoiceOrchestrationGraphDeps) {
  return new StateGraph(VoiceStateAnnotation)
    .addNode('router', deps.router)
    .addNode('conversation_filler', deps.conversationFiller)
    .addNode('parallel_agents', deps.parallelAgents)
    .addNode('synthesize', deps.synthesize)
    .addEdge(START, 'router')
    .addEdge('router', 'conversation_filler')
    .addEdge('conversation_filler', 'parallel_agents')
    .addEdge('parallel_agents', 'synthesize')
    .addEdge('synthesize', END)
    .compile();
}
