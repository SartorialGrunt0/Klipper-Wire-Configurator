import { useEffect, useRef, useState } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useNativeStore } from '../stores/nativeStore';
import { useAiStore } from '../stores/aiStore';
import { getSaveButtonClass } from '../utils/saveButtonClass';
import type { PendingAiChatRequest } from '../types/ai';
import ImportDialog from './dialogs/ImportDialog';
import ExportDialog from './dialogs/ExportDialog';
import DiffDialog from './dialogs/DiffDialog';
import OpenFromPiDialog from './dialogs/OpenFromPiDialog';
import ApplyDialog from './dialogs/ApplyDialog';
import RevertDialog from './dialogs/RevertDialog';
import ChatDialog from './dialogs/ChatDialog';
import FirmwareDialog from './dialogs/FirmwareDialog';

interface ToolbarProps {
  showTextView: boolean;
  onToggleTextView: () => void;
  onToggleAddMenu?: () => void;
  onOpenMacroDesigner?: () => void;
}

type ToolbarItemId =
  | 'import'
  | 'openFromPi'
  | 'export'
  | 'save'
  | 'revert'
  | 'diff'
  | 'aiChat'
  | 'flash'
  | 'component'
  | 'macro';

type ToolbarHiddenState = Record<ToolbarItemId, boolean>;

const TOOLBAR_VISIBILITY_STORAGE_KEY = 'kwc.toolbar.hiddenItems';

const defaultHiddenItems: ToolbarHiddenState = {
  import: false,
  openFromPi: false,
  export: false,
  save: false,
  revert: false,
  diff: false,
  aiChat: false,
  flash: false,
  component: false,
  macro: false,
};

const toolbarVisibilityOptions: Array<{ id: ToolbarItemId; label: string }> = [
  { id: 'import', label: 'Import' },
  { id: 'openFromPi', label: 'Open from Pi' },
  { id: 'export', label: 'Export' },
  { id: 'save', label: 'Save' },
  { id: 'revert', label: 'Revert' },
  { id: 'diff', label: 'Diff' },
  { id: 'aiChat', label: 'AI Chat' },
  { id: 'flash', label: 'Flash' },
  { id: 'component', label: 'Component' },
  { id: 'macro', label: 'Macro' },
];

function loadHiddenItems(): ToolbarHiddenState {
  if (typeof window === 'undefined') {
    return { ...defaultHiddenItems };
  }

  try {
    const raw = window.localStorage.getItem(TOOLBAR_VISIBILITY_STORAGE_KEY);
    if (!raw) {
      return { ...defaultHiddenItems };
    }

    const parsed = JSON.parse(raw) as Partial<Record<ToolbarItemId, unknown>>;
    return {
      import: parsed.import === true,
      openFromPi: parsed.openFromPi === true,
      export: parsed.export === true,
      save: parsed.save === true,
      revert: parsed.revert === true,
      diff: parsed.diff === true,
      aiChat: parsed.aiChat === true,
      flash: parsed.flash === true,
      component: parsed.component === true,
      macro: parsed.macro === true,
    };
  } catch {
    return { ...defaultHiddenItems };
  }
}

export default function Toolbar({
  showTextView,
  onToggleTextView,
  onToggleAddMenu,
  onOpenMacroDesigner,
}: ToolbarProps) {
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showOpenFromPi, setShowOpenFromPi] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const [showRevert, setShowRevert] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [pendingAiRequest, setPendingAiRequest] = useState<PendingAiChatRequest | null>(null);
  const [hiddenItems, setHiddenItems] = useState<ToolbarHiddenState>(() => loadHiddenItems());
  const [showVisibilityMenu, setShowVisibilityMenu] = useState(false);
  const [visibilityMenuPosition, setVisibilityMenuPosition] = useState({ top: 0, left: 0 });
  const aiConfigured = useAiStore((s) => s.isConfigured());
  const chatStatus = useAiStore((s) => s.chatStatus);
  const [showFlash, setShowFlash] = useState(false);
  const hasOriginals = Object.keys(useConfigStore((s) => s.originalTexts)).length > 0;
  const isNative = useNativeStore((s) => s.isNative);
  const hasConfig = Object.keys(useConfigStore((s) => s.configFiles)).length > 0;
  const isConfigDirty = useConfigStore((s) => s.isDirty);
  const validation = useConfigStore((s) => s.validation);
  const hasTextParseError = Object.keys(useConfigStore((s) => s.textParseErrors)).length > 0;
  const hasPendingChanges = isConfigDirty;
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);

  const showImportButton = !hiddenItems.import;
  const showOpenFromPiButton = isNative && !hiddenItems.openFromPi;
  const showExportButton = !hiddenItems.export;
  const showSaveButton = hasConfig && !hiddenItems.save && (isNative === true || hasPendingChanges);
  const showRevertButton = hasPendingChanges && hasOriginals && !hiddenItems.revert;
  const showDiffButton = hasOriginals && !hiddenItems.diff;
  const showAiChatButton = !hiddenItems.aiChat;
  const showFlashButton = isNative && !hiddenItems.flash;
  const showComponentButton = Boolean(onToggleAddMenu) && !hiddenItems.component;
  const showMacroButton = Boolean(onOpenMacroDesigner) && !hiddenItems.macro;

  const showFileGroup = showImportButton || showOpenFromPiButton;
  const showProjectGroup =
    showExportButton || showSaveButton || showRevertButton || showDiffButton;
  const showAiGroup = showAiChatButton || showFlashButton;
  const showBuilderGroup = showComponentButton || showMacroButton;
  const showAnyOptionalGroup =
    showFileGroup || showProjectGroup || showAiGroup || showBuilderGroup;
  const hasHiddenItems = Object.values(hiddenItems).some(Boolean);

  const queueAiAnalyzeRequest = (prompt: string) => {
    const requestId = typeof window !== 'undefined' && window.crypto && 'randomUUID' in window.crypto
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setPendingAiRequest({
      id: requestId,
      prompt,
      hiddenFromUser: true,
    });
    setShowChat(true);
  };

  const updateVisibilityMenuPosition = () => {
    const rect = settingsButtonRef.current?.getBoundingClientRect();
    if (!rect || typeof window === 'undefined') {
      return;
    }

    const menuWidth = 240;
    setVisibilityMenuPosition({
      top: rect.bottom + 8,
      left: Math.max(16, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 16)),
    });
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(TOOLBAR_VISIBILITY_STORAGE_KEY, JSON.stringify(hiddenItems));
  }, [hiddenItems]);

  useEffect(() => {
    if (!showVisibilityMenu) {
      return undefined;
    }

    updateVisibilityMenuPosition();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (settingsMenuRef.current?.contains(target) || settingsButtonRef.current?.contains(target)) {
        return;
      }
      setShowVisibilityMenu(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowVisibilityMenu(false);
      }
    };

    const handleViewportChange = () => {
      updateVisibilityMenuPosition();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [showVisibilityMenu]);

  const toggleToolbarItem = (itemId: ToolbarItemId) => {
    setHiddenItems((state) => ({
      ...state,
      [itemId]: !state[itemId],
    }));
  };

  const resetHiddenItems = () => {
    setHiddenItems({ ...defaultHiddenItems });
  };

  const toggleVisibilityMenu = () => {
    if (showVisibilityMenu) {
      setShowVisibilityMenu(false);
      return;
    }

    updateVisibilityMenuPosition();
    setShowVisibilityMenu(true);
  };

  // Compute Save button color based on dirty state, validation, and whether
  // any file's text currently fails to parse (shared with the Apply/Save
  // dialog so both always agree)
  const saveButtonClass = getSaveButtonClass(isConfigDirty, validation, hasTextParseError);
  return (
    <div className="flex items-center gap-2 min-w-max">
      {/* Import */}
      {showImportButton && (
        <button
          onClick={() => setShowImport(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 10v3a1 1 0 001 1h10a1 1 0 001-1v-3M8 2v9M5 8l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Import
        </button>
      )}

      {/* Open from Pi (native only) */}
      {showOpenFromPiButton && (
        <button
          onClick={() => setShowOpenFromPi(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 3h12v8H2zM5 14h6M8 11v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Open from Pi
        </button>
      )}

      {/* Divider */}
      {showFileGroup && (showProjectGroup || showAiGroup || showBuilderGroup) && (
        <div className="w-px h-5 bg-[var(--color-bg-tertiary)]" />
      )}

      {/* Export */}
      {showExportButton && (
        <button
          onClick={() => setShowExport(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 10v3a1 1 0 001 1h10a1 1 0 001-1v-3M8 11V2M5 5l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Export
        </button>
      )}

      {/* Save to Pi (native only) */}
      {showSaveButton && (
        <button
          onClick={() => setShowApply(true)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${saveButtonClass}`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 8l3.5 3.5L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Save
        </button>
      )}

      {/* Revert Changes (native or when originals exist) */}
      {showRevertButton && (
        <button
          onClick={() => setShowRevert(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 6h7a3 3 0 010 6H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6 3L3 6l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Revert
        </button>
      )}

      {/* Diff */}
      {showDiffButton && (
        <button
          onClick={() => setShowDiff(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M4 3v10M8 3v10M12 6l-4 4M12 10l-4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Diff
        </button>
      )}

      {/* Divider */}
      {showProjectGroup && (showAiGroup || showBuilderGroup) && (
        <div className="w-px h-5 bg-[var(--color-bg-tertiary)]" />
      )}

      {/* AI Chat */}
      {showAiChatButton && (
        <button
          onClick={() => setShowChat(true)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            chatStatus === 'success'
              ? 'bg-green-600 text-white hover:bg-green-700'
              : chatStatus === 'error'
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]'
          }`}
          title={chatStatus === 'success' ? 'AI Chat — response ready' : chatStatus === 'error' ? 'AI Chat — last request failed' : 'AI Chat'}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 1a7 7 0 110 14A7 7 0 018 1z" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M5.5 7.5l2 2 3-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          AI Chat
        </button>
      )}

      {/* Flash */}
      {showFlashButton && (
        <button
          onClick={() => setShowFlash(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 5.5h10M5 2.5h6M5 8.5h6M4.5 11.5h7M4 14h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Flash
        </button>
      )}

      {/* Divider */}
      {showAiGroup && showBuilderGroup && (
        <div className="w-px h-5 bg-[var(--color-bg-tertiary)]" />
      )}
      
      {/* + Component */}
      {showComponentButton && (
        <button
          onClick={onToggleAddMenu}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Component
        </button>
      )}

      {showMacroButton && (
        <button
          onClick={onOpenMacroDesigner}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Macro
        </button>
      )}

      {/* Divider */}
      {showAnyOptionalGroup && <div className="w-px h-5 bg-[var(--color-bg-tertiary)]" />}

      {/* Toggle text/graph view */}
      <button
        onClick={onToggleTextView}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
          showTextView
            ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
            : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]'
        }`}
      >
        {showTextView ? (
          <>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M6 4h4l-4 8h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Graph View
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 4h10M3 8h7M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Text View
          </>
        )}
      </button>

      <button
        ref={settingsButtonRef}
        type="button"
        onClick={toggleVisibilityMenu}
        aria-label="Customize top bar"
        aria-haspopup="dialog"
        aria-expanded={showVisibilityMenu}
        className={`flex items-center justify-center p-1.5 rounded-md transition-colors ${
          showVisibilityMenu
            ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
            : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {showVisibilityMenu && (
        <div
          ref={settingsMenuRef}
          className="fixed z-50 w-60 rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl shadow-black/30"
          style={{ top: visibilityMenuPosition.top, left: visibilityMenuPosition.left }}
        >
          <div className="flex items-start justify-between gap-3 px-3 py-2 border-b border-[var(--color-bg-tertiary)]">
            <div>
              <p className="text-xs font-semibold text-[var(--color-text-primary)]">Top bar items</p>
              <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                Uncheck buttons you want to hide.
              </p>
            </div>
            {hasHiddenItems && (
              <button
                type="button"
                onClick={resetHiddenItems}
                className="text-[11px] px-2 py-1 rounded bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
              >
                Reset
              </button>
            )}
          </div>

          <div className="p-2 space-y-1">
            {toolbarVisibilityOptions.map((item) => {
              const isVisible = !hiddenItems[item.id];

              return (
                <label
                  key={item.id}
                  className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-[var(--color-bg-primary)] transition-colors"
                >
                  <span className="text-xs text-[var(--color-text-primary)]">{item.label}</span>
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                      isVisible
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                        : 'border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] text-transparent'
                    }`}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M2 5.25L4.1 7.35 8 3.45" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={isVisible}
                    onChange={() => toggleToolbarItem(item.id)}
                  />
                </label>
              );
            })}
          </div>

          <div className="px-3 py-2 border-t border-[var(--color-bg-tertiary)] text-[11px] text-[var(--color-text-secondary)]">
            Text view and the settings button stay visible so this menu is always reachable.
          </div>
        </div>
      )}

      {/* Dialogs */}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showDiff && <DiffDialog onClose={() => setShowDiff(false)} />}
      {showOpenFromPi && <OpenFromPiDialog onClose={() => setShowOpenFromPi(false)} />}
      {showApply && (
        <ApplyDialog
          onClose={() => setShowApply(false)}
          canAnalyzeWithAi={aiConfigured && showAiChatButton}
          onAnalyzeWithAi={queueAiAnalyzeRequest}
        />
      )}
      {showFlash && <FirmwareDialog onClose={() => setShowFlash(false)} />}
      {showRevert && <RevertDialog onClose={() => setShowRevert(false)} />}
      {/* ChatDialog stays mounted when closed so an in-flight request keeps
          running; `open` hides/shows the overlay. */}
      <ChatDialog
        open={showChat}
        onClose={() => {
          setShowChat(false);
          setPendingAiRequest(null);
        }}
        pendingRequest={pendingAiRequest}
        onPendingRequestHandled={() => setPendingAiRequest(null)}
      />
    </div>
  );
}
