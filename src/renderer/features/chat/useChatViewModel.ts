import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AssistantBridge } from '../../../shared/bridge';
import { ChatViewModel, type ChatState } from './chatViewModel';

export function useChatViewModel(
  bridge: AssistantBridge,
): [ChatState, ChatViewModel] {
  const [viewModel] = useState(() => new ChatViewModel(bridge));
  const state = useSyncExternalStore(
    viewModel.subscribe,
    viewModel.getSnapshot,
  );

  useEffect(() => {
    void viewModel.init();
    return () => viewModel.dispose();
  }, [viewModel]);

  return [state, viewModel];
}
