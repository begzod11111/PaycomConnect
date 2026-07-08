// Faithful port of services/scriptService.js
const SCRIPT_TEMPLATES: Record<string, any> = {
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
  static normalizeCode(raw: string): string {
    return String(raw ?? '').trim().replace(/^[-\s]+/, '').toLowerCase();
  }

  static getAvailableCodes(): string[] {
    return Object.keys(SCRIPT_TEMPLATES);
  }

  static getByCode(rawCode: string): any {
    const code = ScriptService.normalizeCode(rawCode);
    return SCRIPT_TEMPLATES[code] ?? null;
  }

  private static render(template: string, context: any = {}): string {
    return String(template ?? '').replace(/\{name}/g, context.name || 'технический специалист');
  }

  static buildTelegramText(script: any, code: string, context: any = {}): string {
    const renderedText = ScriptService.render(script.text, context);
    const links =
      Array.isArray(script.links) && script.links.length
        ? `\n\nСсылки:\n${script.links.map((item: string) => `• ${item}`).join('\n')}`
        : '';
    return `${renderedText}${links}`;
  }
}
