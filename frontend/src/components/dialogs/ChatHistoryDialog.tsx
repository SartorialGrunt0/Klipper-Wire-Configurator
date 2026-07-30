import React, { useEffect, useState, useCallback } from 'react';
import { useChatHistoryStore, type SavedConversation } from '../../stores/chatHistoryStore';

interface ChatHistoryDialogProps {
  onClose: () => void;
  onLoadConversation: (conversation: SavedConversation) => void;
  currentMessageCount: number;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `Today at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (diffDays === 1) {
    return `Yesterday at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function getMessageSummary(conversation: SavedConversation): string {
  const msgCount = conversation.messages.length;
  const userCount = conversation.messages.filter((m) => m.role === 'user' && !m.hiddenFromUser).length;
  const assistantCount = conversation.messages.filter((m) => m.role === 'assistant').length;
  return `${msgCount} message${msgCount !== 1 ? 's' : ''} (${userCount} user, ${assistantCount} assistant)`;
}

const ChatHistoryDialog: React.FC<ChatHistoryDialogProps> = ({
  onClose,
  onLoadConversation,
  currentMessageCount,
}) => {
  const { conversations, loadConversations, deleteConversation, clearHistory } = useChatHistoryStore();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const handleLoad = useCallback(
    (conversation: SavedConversation) => {
      onLoadConversation(conversation);
      onClose();
    },
    [onLoadConversation, onClose],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      if (confirmDeleteId === id) {
        deleteConversation(id);
        setConfirmDeleteId(null);
      } else {
        setConfirmDeleteId(id);
      }
    },
    [confirmDeleteId, deleteConversation],
  );

  const handleClearAll = useCallback(() => {
    clearHistory();
  }, [clearHistory]);

  const handleClickOutside = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={handleClickOutside}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[480px] max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Chat History</h2>
          <div className="flex items-center gap-2">
            {conversations.length > 0 && (
              <button
                onClick={handleClearAll}
                className="px-2 py-1 rounded text-[10px] font-medium text-[var(--color-error)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                title="Delete all saved conversations"
              >
                Clear All
              </button>
            )}
            <button
              onClick={onClose}
              className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2">
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-[var(--color-text-secondary)] mb-3 opacity-40">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <p className="text-xs text-[var(--color-text-secondary)]">No saved conversations yet.</p>
              <p className="text-[10px] text-[var(--color-text-secondary)] mt-1 opacity-60">
                Conversations are saved automatically when you start a new chat.
              </p>
            </div>
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                onClick={() => handleLoad(conversation)}
                className="w-full text-left p-3 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors group mb-1"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[var(--color-text-primary)] truncate">
                      {conversation.title}
                    </p>
                    <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                      {formatTimestamp(conversation.timestamp)}
                    </p>
                    <p className="text-[10px] text-[var(--color-text-secondary)] opacity-60">
                      {getMessageSummary(conversation)}
                    </p>
                  </div>
                  <button
                    onClick={(e) => handleDelete(e, conversation.id)}
                    className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                      confirmDeleteId === conversation.id
                        ? 'bg-[var(--color-error)] text-[var(--color-bg-primary)]'
                        : 'text-[var(--color-text-secondary)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-error)]'
                    }`}
                    title="Delete conversation"
                  >
                    {confirmDeleteId === conversation.id ? 'Confirm?' : 'Delete'}
                  </button>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatHistoryDialog;
