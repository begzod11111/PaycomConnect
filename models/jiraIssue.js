import mongoose from 'mongoose';

const jiraIssueSchema = new mongoose.Schema(
  {
    sourceMessageId: {
      type: String,
      required: true,
    },
    platform: {
      type: String,
      required: true,
      enum: ['telegram', 'slack'],
    },
    issueKey: {
      type: String,
      default: '',
    },
    summary: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      required: true,
      enum: ['created', 'mocked', 'failed'],
    },
    mode: {
      type: String,
      required: true,
      enum: ['live', 'mock'],
    },
    // Email исполнителя в Jira — используется для привязки к SlackUser (integrator) по полю email
    assigneeEmail: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
    },
    // Прямая ссылка на интегратора (заполняется при матчинге по email)
    integrator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SlackUser',
      default: null,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

jiraIssueSchema.index({ sourceMessageId: 1 });

export const JiraIssue = mongoose.models.JiraIssue || mongoose.model('JiraIssue', jiraIssueSchema);

