import mongoose from 'mongoose';

const fileSchema = new mongoose.Schema(
  {
    type: String,
    name: String,
    url: String,
    size: Number,
    mimeType: String,
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      required: true,
      enum: ['telegram', 'slack'],
    },
    destination: {
      type: String,
      required: true,
      enum: ['telegram', 'slack'],
    },
    externalId: {
      type: String,
      required: true,
    },
    userId: {
      type: String,
      required: true,
    },
    userName: {
      type: String,
      required: true,
    },
    channelId: {
      type: String,
      default: '',
    },
    text: {
      type: String,
      default: '',
    },
    files: {
      type: [fileSchema],
      default: [],
    },
    firstInteraction: {
      type: Boolean,
      default: false,
    },
    delivery: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    jira: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    messageTimestamp: {
      type: Date,
      required: true,
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

messageSchema.index({ source: 1, externalId: 1 }, { unique: true });
messageSchema.index({ createdAt: -1 });

export const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

