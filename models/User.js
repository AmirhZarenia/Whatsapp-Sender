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
    // WhatsApp-specific fields
    // ==========================================

    // شناسه مخاطب در واتساپ، در صورت نیاز توسط Crawler تکمیل می‌شود.
    whatsappContactId: {
        type: String,
        default: null,
        sparse: true
    },

    // وضعیت اختصاصی کاربر در واتساپ
    // pending: هنوز وضعیت ارسال واتساپ مشخص نشده
    // sent: ارسال موفق واتساپ انجام شده
    // not_registered: این شماره حساب واتساپ ندارد
    whatsappStatus: {
        type: String,
        enum: [
            'pending',
            'sent',
            'not_registered'
        ],
        default: 'pending'
    },

    // تاریخچه پیام‌های ارسال‌شده در واتساپ
    // کاملاً مستقل از سایر پیام‌رسان‌ها
    whatsappReceivedMessages: [{

        messageType: {
            type: String,
            enum: [
                'normal',
                'festival'
            ]
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
