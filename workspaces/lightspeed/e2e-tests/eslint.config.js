import { createEslintConfig } from "@red-hat-developer-hub/e2e-test-utils/eslint";

export default [
  ...createEslintConfig(import.meta.dirname),
  {
    files: ["**/*.spec.ts"],
    rules: {
      "playwright/expect-expect": [
        "warn",
        {
          assertFunctionNames: [
            "assertChatDialogInitialState",
            "assertDrawerState",
            "assertVisibilityState",
            "expectChatInputAreaVisible",
            "expectChatbotControlsVisible",
            "expectConversationArea",
            "expectEmptyChatHistory",
            "expectRhdhContentVisible",
            "uploadAndAssertDuplicate",
            "validateFailedUpload",
            "verifyDisplayModeMenuOptions",
            "verifyChatContextMenuOptions",
            "verifyConversationsSortedAlphabetically",
            "verifyDeleteConfirmation",
            "verifyDisablePinnedChatsOption",
            "verifyEmptyPinnedChatsMessage",
            "verifyEmptySearchResults",
            "verifyEnablePinnedChatsOption",
            "verifyFeedbackButtons",
            "verifyRenameChatForm",
            "verifySidePanelConversation",
            "verifySortDropdownOptions",
          ],
        },
      ],
    },
  },
];
