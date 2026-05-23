const SCRIPT_TEMPLATES = {
  start: {
    title: 'Стартовое приветствие',
    text: `Assalomu alaykum! 
Ismim {name}, Payme texnik mutaxassisiman. Integratsiya nima uchun mo'ljallangan: sayt, mobil ilova yoki Telegram-bot uchunmi?

Здравствуйте! 
Меня зовут {name}, я технический специалист Payme. Подскажите, для какой платформы планируется интеграция: сайт, мобильное приложение или Telegram-бот?`,
    links: [],
    files: [],
  },
};

export class ScriptService {
  static normalizeCode(raw) {
    return String(raw ?? '').trim().replace(/^[-\s]+/, '').toLowerCase();
  }

  static getAvailableCodes() {
    return Object.keys(SCRIPT_TEMPLATES);
  }

  static getByCode(rawCode) {
    const code = ScriptService.normalizeCode(rawCode);
    return SCRIPT_TEMPLATES[code] ?? null;
  }

  static #render(template, context = {}) {
    return String(template ?? '').replace(/\{name}/g, context.name || 'технический специалист');
  }

  static buildTelegramText(script, code, context = {}) {
    const renderedText = ScriptService.#render(script.text, context);
    const links = Array.isArray(script.links) && script.links.length
      ? `\n\nСсылки:\n${script.links.map((item) => `• ${item}`).join('\n')}`
      : '';

    return `${renderedText}${links}`;
  }
}



