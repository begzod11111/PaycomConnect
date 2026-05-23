import mongoose from 'mongoose';

const contactSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      enum: ['telegram', 'slack'],
    },
    userId: {
      type: String,
      required: true,
    },
    userName: {
      type: String,
      default: 'Unknown user',
    },
    channels: {
      type: [String],
      default: [],
    },
    firstMessageAt: {
      type: Date,
      required: true,
    },
    lastMessageAt: {
      type: Date,
      required: true,
    },
    messageCount: {
      type: Number,
      default: 1,
    },
  },
  {
    timestamps: true,
  },
);

contactSchema.index({ platform: 1, userId: 1 }, { unique: true });

export const Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);

