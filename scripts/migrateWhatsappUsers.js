import mongoose from 'mongoose';
import 'dotenv/config';

const mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
    throw new Error('MONGO_URI در .env تنظیم نشده است.');
}

await mongoose.connect(mongoUri);

const users = mongoose.connection.collection('users');

const result = await users.updateMany(
    {
        whatsappStatus: { $exists: false }
    },
    {
        $set: {
            whatsappContactId: null,
            whatsappStatus: 'pending',
            whatsappReceivedMessages: []
        }
    }
);

console.log(`✅ کاربران بررسی شدند | matched=${result.matchedCount} | modified=${result.modifiedCount}`);

await mongoose.disconnect();

// npm run migrate:whatsapp
