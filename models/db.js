import mongoose from "mongoose";
import {ChannelLink} from "./channelLink.js";
import {Message} from "./message.js";
import {Contact} from "./contact.js";
import {JiraIssue} from "./jiraIssue.js";


/**
 * Подключение к MongoDB с повтором при ошибке
 * @param {string} uri - MongoDB connection string (можно передать или взять из process.env)
 * @param {number} retryCount - количество попыток
 * @param {number} retryDelay - задержка между попытками (мс)
 * @returns {Promise<mongoose.Connection>}
 */
export async function connectDB(uri, retryCount = 3, retryDelay = 3000) {
  const connectionString = uri || process.env.MONGODB_URI_PROD || process.env.MONGODB_URI;

  if (!connectionString) {
    console.error('MONGODB_URI is not defined in environment');
    process.exit(1);
  }

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      await mongoose.connect(connectionString, {
        tls: true,
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000
      });
      console.log('Connected to MongoDB');
      return mongoose.connection;
    } catch (err) {
      console.error(`MongoDB connection attempt ${attempt} failed:`, err.message);
      if (attempt === retryCount) {
        console.error('Max retry attempts reached. Exiting...');
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}


export const models = {
    ChannelLink,
    Message,
    Contact,
    JiraIssue
};