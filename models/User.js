import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    mobile: {
        type: String,
        required: true,
        unique: true
    },

    businessName: {
        type: String,
        required: true
    },

    category: {
        type: String,
        default: 'مشتری',
        required: true
    },

    tags: [{
        type: String,
        required: true
    }],

    isBlocked: {
        type: Boolean,
        default: false,
        required: true
    },

    isActive: {
        type: Boolean,
        default: true
    },

    // ==========================================
    // Rubika-specific fields
    // ==========================================

    // GUID مخاطب در روبیکا
    rubikaGuid: {
        type: String,
        default: null,
        sparse: true
    },

    // pending: هنوز وضعیت ارسال روبیکا مشخص نشده
    // sent: ارسال موفق روبیکا انجام شده
    // not_registered: این شماره حساب روبیکا ندارد
    rubikaStatus: {
        type: String,
        enum: ['pending', 'sent', 'not_registered'],
        default: 'pending'
    },

    // تاریخچه پیام‌های ارسال‌شده در روبیکا؛ مستقل از Bale و WhatsApp
    rubikaReceivedMessages: [{
        messageType: {
            type: String,
            enum: ['normal', 'festival']
        },
        subject: {
            type: String
        },
        sentAt: {
            type: Date,
            default: Date.now
        }
    }],

    // ==========================================
    // Bale-specific fields
    // ==========================================

    // تاریخچه پیام‌های ارسال‌شده در Bale؛ مستقل از Rubika و WhatsApp
    receivedMessages: [{
        messageType: {
            type: String,
            enum: ['normal', 'festival']
        },
        subject: {
            type: String
        },
        sentAt: {
            type: Date,
            default: Date.now
        }
    }],

    // وضعیت کلی کاربر برای Bale
    status: {
        type: String,
        enum: ['pending', 'sent'],
        default: 'pending'
    },

    // ==========================================
    // WhatsApp-specific fields
    // ==========================================

    // شناسه مخاطب در واتساپ (در صورت وجود)
    whatsappContactId: {
        type: String,
        default: null
    },

    // وضعیت مستقل کاربر برای واتساپ
    // pending: هنوز وضعیت ارسال واتساپ مشخص نشده
    // sent: ارسال موفق واتساپ انجام شده
    // not_registered: این شماره حساب واتساپ ندارد
    whatsappStatus: {
        type: String,
        enum: ['pending', 'sent', 'not_registered'],
        default: 'pending'
    },

    // تاریخچه پیام‌های ارسال‌شده در واتساپ؛ مستقل از Bale و Rubika
    whatsappReceivedMessages: [{
        messageType: {
            type: String,
            enum: ['normal', 'festival']
        },
        subject: {
            type: String
        },
        sentAt: {
            type: Date,
            default: Date.now
        }
    }]

}, {
    timestamps: true,
    collection: 'users'
});


export default mongoose.model('User', userSchema);