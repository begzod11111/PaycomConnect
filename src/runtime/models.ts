import mongoose from 'mongoose';

// Faithful ports of the existing Mongoose models so the DB shape is unchanged
// after the cutover. These will be replaced by the entity schemas under
// src/domain/* in a later cleanup once data is backfilled.

// ── ChannelLink ──────────────────────────────────────────────────────────────
const channelLinkSchema = new mongoose.Schema(
  {
    inn: { type: String, required: true, index: true },
    status: {
      type: String,
      required: true,
      enum: ['pending_telegram', 'pending_slack', 'linked', 'suspended'],
      default: 'pending_slack',
    },
    telegramChatId: { type: String, default: '' },
    telegramChatTitle: { type: String, default: '' },
    telegramChatType: { type: String, default: '' },
    telegramInitiatorId: { type: String, default: '' },
    telegramInitiatorName: { type: String, default: '' },
    slackChannelId: { type: String, default: '' },
    slackChannelName: { type: String, default: '' },
    slackTeamId: { type: String, default: '' },
    slackUserId: { type: String, default: '' },
    slackUserName: { type: String, default: '' },
    jiraProjectKey: { type: String, default: '' },
    jiraIssueKey: { type: String, default: '' },
    jiraIssueUrl: { type: String, default: '' },
    jiraTaskKeys: { type: [String], default: [] },
    activationSource: { type: String, enum: ['telegram', 'slack', 'system'], default: 'system' },
    linkedAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: Date.now },
    stats: {
      messagesFromTelegram: { type: Number, default: 0 },
      messagesFromSlack: { type: Number, default: 0 },
      totalMessages: { type: Number, default: 0 },
    },
    integrators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SlackUser' }],
    managers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SlackUser' }],
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);
channelLinkSchema.index({ inn: 1 }, { unique: true });
channelLinkSchema.index({ telegramChatId: 1 }, { sparse: true });
channelLinkSchema.index({ slackChannelId: 1 }, { sparse: true });
channelLinkSchema.index({ status: 1 });

export const ChannelLink =
  mongoose.models.ChannelLink || mongoose.model('ChannelLink', channelLinkSchema);

// ── Contact ──────────────────────────────────────────────────────────────────
const contactSchema = new mongoose.Schema(
  {
    platform: { type: String, required: true, enum: ['telegram', 'slack'] },
    userId: { type: String, required: true },
    userName: { type: String, default: 'Unknown user' },
    channelId: { type: String, default: '' },
    firstInteractionAt: { type: Date, default: Date.now },
    lastInteractionAt: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 1 },
  },
  { timestamps: true },
);
contactSchema.index({ platform: 1, userId: 1 }, { unique: true });

export const Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);

// ── Message ──────────────────────────────────────────────────────────────────
const fileSchema = new mongoose.Schema(
  { type: String, name: String, url: String, size: Number, mimeType: String },
  { _id: false },
);
const messageSchema = new mongoose.Schema(
  {
    source: { type: String, required: true, enum: ['telegram', 'slack'] },
    destination: { type: String, required: true, enum: ['telegram', 'slack'] },
    externalId: { type: String, required: true },
    userId: { type: String, required: true },
    userName: { type: String, required: true },
    channelId: { type: String, default: '' },
    text: { type: String, default: '' },
    files: { type: [fileSchema], default: [] },
    firstInteraction: { type: Boolean, default: false },
    delivery: { type: mongoose.Schema.Types.Mixed, default: null },
    jira: { type: mongoose.Schema.Types.Mixed, default: null },
    messageTimestamp: { type: Date, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);
messageSchema.index({ source: 1, externalId: 1 }, { unique: true });
messageSchema.index({ createdAt: -1 });

export const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

// ── JiraIssue ────────────────────────────────────────────────────────────────
const jiraIssueSchema = new mongoose.Schema(
  {
    sourceMessageId: { type: String, required: true },
    platform: { type: String, required: true, enum: ['telegram', 'slack'] },
    issueKey: { type: String, default: '' },
    summary: { type: String, required: true },
    description: { type: String, default: '' },
    status: { type: String, required: true, enum: ['created', 'mocked', 'failed'] },
    mode: { type: String, required: true, enum: ['live', 'mock'] },
    assigneeEmail: { type: String, default: '', lowercase: true, trim: true },
    integrator: { type: mongoose.Schema.Types.ObjectId, ref: 'SlackUser', default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);
jiraIssueSchema.index({ sourceMessageId: 1 });

export const JiraIssue = mongoose.models.JiraIssue || mongoose.model('JiraIssue', jiraIssueSchema);

// ── SlackUser ────────────────────────────────────────────────────────────────
const slackUserSchema = new mongoose.Schema(
  {
    slackId: { type: String, required: true, unique: true },
    telegramId: { type: String, default: null, sparse: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, default: '' },
    role: {
      type: String,
      required: false,
      enum: ['manager', 'integrator', 'b2b_support', 'owner', 'teamlead', 'cx_manager', null],
      default: null,
    },
    status: { type: String, required: true, enum: ['pending', 'active', 'rejected'], default: 'pending' },
    connects: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ChannelLink' }],
    jiraIssues: [{ type: mongoose.Schema.Types.ObjectId, ref: 'JiraIssue' }],
    isActive: { type: Boolean, default: true },
    verificationCode: { type: String, default: null },
    verificationCodeExpiresAt: { type: Date, default: null },
    verificationCodeUsed: { type: Boolean, default: false },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);
slackUserSchema.index({ role: 1 });
slackUserSchema.index({ telegramId: 1 }, { sparse: true });

export const SlackUser =
  mongoose.models.SlackUser || mongoose.model('SlackUser', slackUserSchema);

export const models = { ChannelLink, Contact, Message, JiraIssue, SlackUser };
