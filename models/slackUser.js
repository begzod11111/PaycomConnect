import mongoose from 'mongoose';

/**
 * SlackUser — Slack-пользователь системы.
 * Роли:
 *   manager      — менеджер, ведёт подключения (connects)
 *   integrator   — интегратор, ведёт подключения + Jira-таски
 *   b2b_support  — поддержка B2B
 */
const slackUserSchema = new mongoose.Schema(
  {
    slackId: {
      type: String,
      required: true,
      unique: true,
    },
    // Telegram user ID — для связи аккаунта с Telegram-ботом
    telegramId: {
      type: String,
      default: null,
      sparse: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    displayName: {
      type: String,
      default: '',
    },
    role: {
      type: String,
      required: false,
      enum: ['manager', 'integrator', 'b2b_support', 'owner', 'teamlead', 'cx_manager', null],
      default: null,
    },

    // pending  — ждёт апрува модератора
    // active   — апрувнут, имеет роль
    // rejected — отклонён
    status: {
      type: String,
      required: true,
      enum: ['pending', 'active', 'rejected'],
      default: 'pending',
    },

    // ── Connects (ChannelLink._id) ──────────────────────────────────────────
    // Актуально для manager и integrator
    connects: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChannelLink',
      },
    ],

    // ── Jira-таски ──────────────────────────────────────────────────────────
    // Актуально только для integrator.
    // Связь по email пользователя в Jira (assignee/reporter).
    jiraIssues: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'JiraIssue',
      },
    ],

    isActive: {
      type: Boolean,
      default: true,
    },

    // ── Двухфакторная регистрация ──────────────────────────────────────────────
    // 6-значный код для подтверждения регистрации в Telegram
    verificationCode: {
      type: String,
      default: null,
    },
    verificationCodeExpiresAt: {
      type: Date,
      default: null,
    },
    verificationCodeUsed: {
      type: Boolean,
      default: false,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

// Индексы
slackUserSchema.index({ role: 1 });
slackUserSchema.index({ email: 1 });
slackUserSchema.index({ telegramId: 1 }, { sparse: true });

export const SlackUser =
  mongoose.models.SlackUser || mongoose.model('SlackUser', slackUserSchema);

