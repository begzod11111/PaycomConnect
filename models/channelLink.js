import mongoose from 'mongoose';

const channelLinkSchema = new mongoose.Schema(
  {
    inn: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['pending_telegram', 'pending_slack', 'linked', 'suspended'],
      default: 'pending_slack',
    },
    // Telegram
    telegramChatId: {
      type: String,
      default: '',
    },
    telegramChatTitle: {
      type: String,
      default: '',
    },
    telegramChatType: {
      type: String,
      default: '',
    },
    telegramInitiatorId: {
      type: String,
      default: '',
    },
    telegramInitiatorName: {
      type: String,
      default: '',
    },
    // Slack
    slackChannelId: {
      type: String,
      default: '',
    },
    slackChannelName: {
      type: String,
      default: '',
    },
    slackTeamId: {
      type: String,
      default: '',
    },
    slackUserId: {
      type: String,
      default: '',
    },
    slackUserName: {
      type: String,
      default: '',
    },
    // JIRA (опционально)
    jiraProjectKey: {
      type: String,
      default: '',
    },
    jiraIssueKey: {
      type: String,
      default: '',
    },
    jiraIssueUrl: {
      type: String,
      default: '',
    },
    jiraTaskKeys: {
      type: [String],
      default: [],
    },
    // Активация
    activationSource: {
      type: String,
      enum: ['telegram', 'slack', 'system'],
      default: 'system',
    },
    linkedAt: {
      type: Date,
      default: null,
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
    // Статистика (опционально)
    stats: {
      messagesFromTelegram: {
        type: Number,
        default: 0,
      },
      messagesFromSlack: {
        type: Number,
        default: 0,
      },
      totalMessages: {
        type: Number,
        default: 0,
      },
    },
    // ── Ответственные сотрудники ────────────────────────────────────────────
    // Интеграторы: один или несколько (роль 'integrator')
    integrators: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SlackUser',
      },
    ],
    // Менеджеры: один или несколько (роль 'manager')
    managers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SlackUser',
      },
    ],

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

channelLinkSchema.index({ inn: 1 }, { unique: true });
channelLinkSchema.index({ telegramChatId: 1 }, { sparse: true });
channelLinkSchema.index({ slackChannelId: 1 }, { sparse: true });
channelLinkSchema.index({ status: 1 });

export const ChannelLink = mongoose.models.ChannelLink || mongoose.model('ChannelLink', channelLinkSchema);

