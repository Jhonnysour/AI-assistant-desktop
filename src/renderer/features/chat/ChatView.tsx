// Vista mínima para comprobar el recorrido completo. El diseño definitivo llega en la fase 2.

import { useState, type KeyboardEvent } from 'react';
import type { AssistantBridge } from '../../../shared/bridge';
import type { ResponseStatus } from '../../../shared/chat-api';
import type { AssistantItem, ChatViewModel } from './chatViewModel';
import { useChatViewModel } from './useChatViewModel';

const STATUS_LABELS: Record<ResponseStatus, string> = {
  streaming: 'Recibiendo…',
  completed: 'Completada',
  failed: 'Error',
  interrupted: 'Interrumpida (respuesta parcial)',
  cancelled: 'Cancelada',
};

export function ChatView({ bridge }: { bridge: AssistantBridge }) {
  const [state, vm] = useChatViewModel(bridge);
  const [renaming, setRenaming] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const busy = state.sendPhase !== 'idle';

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void vm.send();
    }
  };

  if (vm.backendUnavailable) {
    return (
      <main className="layout">
        <section className="chat">
          <p role="alert">{state.modelsError?.message}</p>
          <button onClick={() => void vm.init()}>Reintentar</button>
        </section>
      </main>
    );
  }

  return (
    <main className="layout">
      <aside className="sidebar">
        <button onClick={() => vm.newConversation()} disabled={busy}>
          Nueva conversación
        </button>
        {state.conversationsError && (
          <p role="alert">{state.conversationsError.message}</p>
        )}
        {state.conversationsStatus === 'ready' &&
          state.conversations.length === 0 && <p>No hay conversaciones.</p>}
        <ul>
          {state.conversations.map((c) => (
            <li key={c.conversation_id}>
              {renaming?.id === c.conversation_id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void vm
                      .renameConversation(renaming.id, renaming.title)
                      .then((ok) => ok && setRenaming(null));
                  }}
                >
                  <input
                    aria-label="Nuevo título"
                    value={renaming.title}
                    onChange={(e) =>
                      setRenaming({ ...renaming, title: e.target.value })
                    }
                  />
                  <button type="submit">Guardar</button>
                  <button type="button" onClick={() => setRenaming(null)}>
                    Cancelar
                  </button>
                </form>
              ) : (
                <>
                  <button
                    onClick={() => void vm.openConversation(c.conversation_id)}
                    disabled={busy}
                    aria-current={
                      c.conversation_id === state.activeConversationId
                    }
                  >
                    {c.title ?? 'Sin título'}
                  </button>
                  <button
                    onClick={() =>
                      setRenaming({
                        id: c.conversation_id,
                        title: c.title ?? '',
                      })
                    }
                  >
                    Renombrar
                  </button>
                  {confirmDelete === c.conversation_id ? (
                    <>
                      <span>¿Borrar definitivamente?</span>
                      <button
                        onClick={() =>
                          void vm
                            .deleteConversation(c.conversation_id)
                            .then(() => setConfirmDelete(null))
                        }
                      >
                        Sí, borrar
                      </button>
                      <button onClick={() => setConfirmDelete(null)}>No</button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(c.conversation_id)}
                      disabled={
                        busy && c.conversation_id === state.activeConversationId
                      }
                    >
                      Borrar
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat">
        <header>
          <label>
            Modelo{' '}
            <select
              value={state.selectedModel ?? ''}
              onChange={(e) => vm.selectModel(e.target.value)}
              disabled={state.models.length === 0}
            >
              {state.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name} (
                  {m.access === 'verified'
                    ? 'acceso comprobado'
                    : 'sin comprobar'}
                  )
                </option>
              ))}
            </select>
          </label>
          {state.modelsError && (
            <span role="alert">
              Catálogo no disponible: {state.modelsError.message}{' '}
              <button onClick={() => void vm.loadModels()}>Reintentar</button>
            </span>
          )}
        </header>

        {state.persisted === false && (
          <p role="status">
            Esta conversación no se guarda: el backend funciona sin base de
            datos.
          </p>
        )}
        {state.error && (
          <p role="alert">
            {state.error.message}{' '}
            <button onClick={() => vm.dismissError()}>Cerrar</button>
          </p>
        )}

        <ol className="messages">
          {state.conversationStatus === 'loading' && <li>Cargando…</li>}
          {state.items.map((item) =>
            item.kind === 'user' ? (
              <li key={item.key} className="user">
                <strong>Tú:</strong> <span className="text">{item.text}</span>
              </li>
            ) : (
              <AssistantMessage key={item.key} item={item} vm={vm} />
            ),
          )}
        </ol>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void vm.send();
          }}
        >
          <textarea
            aria-label="Mensaje"
            value={state.draft}
            onChange={(e) => vm.setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
          />
          {state.validation && <p role="alert">{state.validation}</p>}
          <button type="submit" disabled={!vm.canSend}>
            Enviar
          </button>
          {state.sendPhase === 'streaming' && (
            <button
              type="button"
              onClick={() => void vm.cancel()}
              disabled={!vm.canCancel}
            >
              Cancelar respuesta
            </button>
          )}
        </form>
      </section>
    </main>
  );
}

function AssistantMessage({
  item,
  vm,
}: {
  item: AssistantItem;
  vm: ChatViewModel;
}) {
  return (
    <li className="assistant" data-status={item.status}>
      <strong>Asistente</strong> <em>[{STATUS_LABELS[item.status]}]</em>
      <div
        className="text"
        aria-live={item.status === 'streaming' ? 'polite' : undefined}
      >
        {item.text}
      </div>
      {item.error && <p role="alert">{item.error.message}</p>}
      {item.error?.retryable && (
        <button onClick={() => void vm.retry(item.key)} disabled={!vm.canSend}>
          Reintentar
        </button>
      )}
    </li>
  );
}
