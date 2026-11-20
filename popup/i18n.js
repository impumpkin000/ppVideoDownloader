export function t(messageName, substitutions) {
  let message;
  try {
    message = chrome.i18n.getMessage(messageName, substitutions);
  } catch (error) {
    if (error instanceof Error && error.message === 'Extension context invalidated.') {
      return messageName;
    }
    throw error;
  }
  if (!message) {
    throw new Error(`Missing localized message: ${messageName}`);
  }
  return message;
}

export function setDocumentLanguage() {
  const locale = chrome.i18n.getUILanguage().replace('_', '-');
  document.documentElement.lang = locale;
}
