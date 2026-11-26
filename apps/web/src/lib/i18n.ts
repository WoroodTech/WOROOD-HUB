import { useEffect, useRef, type ReactNode } from 'react';
import { useAppearance } from './theme';

export type TextTranslation = Record<string, string>;

export const AR_DEPARTMENTS: TextTranslation = {
  'Executive': 'الإدارة التنفيذية',
  'Sales': 'المبيعات',
  'Marketing': 'التسويق',
  'Finance': 'المالية',
  'Operations': 'العمليات',
  'Customer Care': 'خدمة العملاء',
  'Facilities': 'الخدمات',
  'Technology': 'التقنية',
  'Human Resources': 'الموارد البشرية',
  'Administration': 'الإدارة',
  'Warehouse': 'المخزن',
  'Purchases': 'المشتريات',
  'Customer Support': 'دعم العملاء',
  'Public Relations': 'العلاقات العامة',
  'Office': 'المكتب',
  'Workshop': 'الورشة',
};

export const AR_ROLES: TextTranslation = {
  'System Administrator': 'مدير النظام',
  'Admin': 'مسؤول النظام',
};

export function isArabic(): boolean {
  return typeof document !== 'undefined'
    && (document.documentElement.lang || '').startsWith('ar');
}

export function localizedName(
  english: string | null | undefined,
  arabic: string | null | undefined,
  extra: TextTranslation = {},
): string {
  if (!isArabic()) return english ?? '';
  if (arabic?.trim()) return arabic;
  if (english && extra[english]) return extra[english];
  if (english && AR_DEPARTMENTS[english]) return AR_DEPARTMENTS[english];
  if (english && AR_ROLES[english]) return AR_ROLES[english];
  return english ?? '';
}

export const AR_TEXT: TextTranslation = {
  'Conversation': 'المحادثة',
  'Open template': 'فتح النموذج',
  'Make Conversation': 'إنشاء محادثة',
  'Close Conversation': 'إغلاق المحادثة',
  'Open Template': 'فتح النموذج',
  'Report a problem': 'الإبلاغ عن مشكلة',
  'Complete — all correct': 'مكتمل — كله سليم',
  'Which patches': 'أي باتشات',
  'Complete': 'مكتمل',
  'Add an item': 'إضافة صنف',
  'Nothing ticked yet': 'لم يتم تحديد شيء بعد',
  'Warehouse (Approval / Receiving)': 'المخزن (الاعتماد والاستلام)',
  'Hand rolls over to the workshop': 'تسليم الألفات للورشة',
  'Record receiving': 'تسجيل الاستلام',
  'Rolls performance': 'أداء الألفات',
  'Accuracy': 'الدقة',
  'Stock age': 'عمر المخزون',
  'Rolls received': 'الألفات المستلمة',
  'Roll cycle time': 'زمن دورة اللفة',
  'Pieces received': 'القطع المستلمة',
  'Fabric in stock': 'القماش في المخزن',
  'Good pieces': 'القطع السليمة',
  'Expected units': 'الوحدات المتوقعة',
  'Missing %': 'نسبة الناقص',
  'Export Excel (CSV)': 'تصدير إكسل (CSV)',
  'Print / PDF': 'طباعة / PDF',
  'Light': 'فاتح',
  'Dark': 'داكن',
  'System': 'النظام',
  'Appearance': 'المظهر',
  'Switch to dark': 'التبديل إلى الداكن',
  'Switch to light': 'التبديل إلى الفاتح',
  'Follow system setting': 'اتباع إعداد النظام',
  'currently': 'حاليًا',
  'Switch to Arabic (right-to-left)': 'التبديل إلى العربية (من اليمين إلى اليسار)',
  'Switch to English (left-to-right)': 'التبديل إلى الإنجليزية (من اليسار إلى اليمين)',
  'Switch to Arabic, right to left': 'التبديل إلى العربية، من اليمين إلى اليسار',
  'Switch to English, left to right': 'التبديل إلى الإنجليزية، من اليسار إلى اليمين',

  'Home': 'الرئيسية',
  'Logout': 'تسجيل الخروج',
  'Sign out': 'تسجيل الخروج',
  'Profile': 'الملف الشخصي',
  'Settings': 'الإعدادات',
  'Notifications': 'الإشعارات',
  'Search': 'بحث',
  'Search...': 'بحث...',
  'Loading': 'جارٍ التحميل',
  'Loading…': 'جارٍ التحميل…',
  'Loading...': 'جارٍ التحميل...',
  'Restoring your session…': 'جارٍ استعادة جلستك…',
  'Please wait': 'يرجى الانتظار',
  'Not found': 'غير موجود',
  'Page not found': 'الصفحة غير موجودة',
  'Something went wrong': 'حدث خطأ ما',
  'Try again': 'حاول مرة أخرى',
  'Retry': 'إعادة المحاولة',
  'Save': 'حفظ',
  'Saved': 'تم الحفظ',
  'Cancel': 'إلغاء',
  'Close': 'إغلاق',
  'Back': 'رجوع',
  'Next': 'التالي',
  'Submit': 'إرسال',
  'Create': 'إنشاء',
  'Created': 'تم الإنشاء',
  'Edit': 'تعديل',
  'Update': 'تحديث',
  'Updated': 'تم التحديث',
  'Delete': 'حذف',
  'Deleted': 'تم الحذف',
  'Remove': 'إزالة',
  'Confirm': 'تأكيد',
  'Yes': 'نعم',
  'No': 'لا',
  'Add': 'إضافة',
  'Details': 'التفاصيل',
  'Actions': 'الإجراءات',
  'Mark all read': 'تحديد الكل كمقروء',
  'Show these on my desktop while the portal is open':
    'إظهار هذه الإشعارات على سطح المكتب أثناء فتح البوابة',
  'Working…': 'جارٍ التنفيذ…',
  'This portal build has no component for this item yet. Nothing else on the page is affected.':
    'لا يحتوي هذا الإصدار من البوابة على مكوّن لهذا العنصر بعد. لا يتأثر باقي محتوى الصفحة.',
  'Not available to your account': 'غير متاح لحسابك',
  'Could not load this': 'تعذر تحميل هذا',
  'Something went wrong.': 'حدث خطأ ما.',
  'Provisional': 'مبدئي',
  'Generated': 'تم إنشاءه',
  ' of ': ' من ',
  'Previous': 'السابق',
  'Name': 'الاسم',
  'Email': 'البريد الإلكتروني',
  'Department': 'القسم',
  'Departments': 'الأقسام',
  'Role': 'الدور',
  'Roles': 'الأدوار',
  'Person': 'الشخص',
  'People': 'الموظفون',
  'Users': 'المستخدمون',
  'User': 'المستخدم',
  'Date': 'التاريخ',
  'Time': 'الوقت',
  'From': 'من',
  'To': 'إلى',
  'Type': 'النوع',
  'Amount': 'المبلغ',
  'Total': 'الإجمالي',
  'Quantity': 'الكمية',
  'Description': 'الوصف',
  'Notes': 'ملاحظات',
  'Note': 'ملاحظة',
  'Comment': 'تعليق',
  'Comments': 'تعليقات',
  'Reason': 'السبب',
  'Active': 'نشط',
  'Inactive': 'غير نشط',
  'Pending': 'قيد الانتظار',
  'Approved': 'موافق عليه',
  'Rejected': 'مرفوض',
  'Resolved': 'تم الحل',
  'Open': 'مفتوح',
  'Closed': 'مغلق',
  'Draft': 'مسودة',
  'Published': 'تم النشر',
  'Archived': 'مؤرشف',
  'Success': 'نجاح',
  'Failed': 'فشل',
  'Error': 'خطأ',
  'Warning': 'تحذير',
  'All': 'الكل',
  'None': 'لا شيء',
  'Today': 'اليوم',
  'Tomorrow': 'غدًا',
  'Yesterday': 'أمس',
  'This week': 'هذا الأسبوع',
  'This month': 'هذا الشهر',
  'Last month': 'الشهر الماضي',
  'Clear': 'مسح',
  'Filter': 'تصفية',
  'Filters': 'مرشحات',
  'Refresh': 'تحديث',
  'Export': 'تصدير',
  'Download': 'تنزيل',
  'Upload': 'رفع',
  'Print': 'طباعة',
  'Copy': 'نسخ',
  'Copied': 'تم النسخ',
  'More': 'المزيد',
  'More actions': 'المزيد من الإجراءات',
  'Show': 'عرض',
  'Hide': 'إخفاء',
  'No results': 'لا توجد نتائج',
  'No data': 'لا توجد بيانات',
  'No items': 'لا توجد عناصر',
  'No matching results': 'لا توجد نتائج مطابقة',
  'Are you sure?': 'هل أنت متأكد؟',
  'This cannot be undone.': 'لا يمكن التراجع عن هذا.',
  'Required': 'مطلوب',
  'Optional': 'اختياري',
  'Select': 'اختر',
  'Select an option': 'اختر خيارًا',
  'Work e-mail': 'البريد الإلكتروني للعمل',
  'Password': 'كلمة المرور',
  'your password': 'كلمة المرور',
  'Sign in': 'تسجيل الدخول',
  'Signing in…': 'جارٍ تسجيل الدخول…',
  'Enter email': 'أدخل البريد الإلكتروني',
  'Enter password': 'أدخل كلمة المرور',
  'No account yet?': 'ليس لديك حساب بعد؟',
  'Ask for one': 'اطلب حسابًا',
  'Ask for an account. Somebody will approve it before you can sign in.':
    'اطلب حسابًا. سيعتمده شخص مسؤول قبل أن تتمكن من تسجيل الدخول.',
  'At least 8 characters': '8 أحرف على الأقل',
  'A number or a symbol': 'رقم أو رمز',
  'Too short': 'قصير جدًا',
  'Fine': 'مقبول',
  'Strong': 'قوي',
  'Password meets the requirements': 'كلمة المرور تستوفي المتطلبات',
  'Full name': 'الاسم الكامل',
  'Request sent': 'تم إرسال الطلب',
  'Back to sign in': 'العودة لتسجيل الدخول',
  'Skip to content': 'انتقل إلى المحتوى',
  'Close navigation': 'إغلاق القائمة',
  'Open navigation': 'فتح القائمة',
  'Navigation unavailable.': 'القائمة غير متاحة.',
  'Connecting': 'جارٍ الاتصال',
  'Live': 'مباشر',
  'Reconnecting': 'جارٍ إعادة الاتصال',
  'Not live': 'غير مباشر',

  'Finance': 'المالية',
  'Tasks': 'المهام',
  'Tickets': 'التذاكر',
  'Sales': 'المبيعات',
  'Company News': 'أخبار الشركة',
  'News': 'الأخبار',
  'Tasks & Tickets': 'المهام والتذاكر',
  'Meeting Rooms': 'غرف الاجتماعات',
  'Sales Dashboard': 'لوحة المبيعات',
  'Sales Dashboard and Shopify': 'لوحة المبيعات وShopify',
  'Human Resources': 'الموارد البشرية',
  'Administration': 'الإدارة',
  'Company': 'الشركة',
  'Employee': 'موظف',
  'Employees': 'الموظفون',
  'Manager': 'مدير',
  'Managers': 'مديرون',

  'Receiving': 'استلام',
  'Receive': 'استلام',
  'Transfer': 'تحويل',
  'Returns': 'المرتجعات',
  'Return': 'إرجاع',
  'Post': 'ترحيل',
  'Posting': 'جارٍ الترحيل',
  'Patch': 'دفعة',
  'Patch number': 'رقم الدفعة',
  'Order': 'طلب',
  'Orders': 'الطلبات',
  'Order number': 'رقم الطلب',
  'National order': 'الطلب المحلي',
  'Global order': 'الطلب الدولي',
  'Item': 'الصنف',
  'Items': 'الأصناف',
  'Item code': 'كود الصنف',
  'Item name': 'اسم الصنف',
  'Colour': 'اللون',
  'Color': 'اللون',
  'Kind': 'النوع',
  'Material': 'الخامة',
  'Warehouse': 'المستودع',
  'Location': 'الموقع',
  'Locations': 'المواقع',
  'Stock': 'المخزون',
  'Stock in': 'مخزون وارد',
  'Stock out': 'مخزون صادر',
  'Balance': 'الرصيد',
  'Available': 'متاح',
  'Short': 'ناقص',
  'Shortage': 'نقص',
  'Approve': 'اعتماد',
  'Approval': 'اعتماد',
  'Approvals': 'اعتمادات',
  'Reject': 'رفض',
  'Quality': 'الجودة',
  'Quality check': 'فحص الجودة',
  'QC': 'الجودة',
  'Roll': 'لفة',
  'Rolls': 'الألفات',
  'Production': 'الإنتاج',
  'Planning': 'التخطيط',
  'Reports': 'التقارير',
  'Labels': 'الملصقات',
  'Documents': 'المستندات',
  'Attachments': 'المرفقات',
  'File': 'ملف',
  'Files': 'الملفات',
  'New item': 'صنف جديد',
  'Create item': 'إنشاء صنف',
  'Preview': 'معاينة',
  'Sheet': 'جدول',
  'Google Sheets': 'جداول Google',
  'Serial': 'مسلسل',
  'Serial number': 'الرقم التسلسلي',
  'Movement': 'حركة',
  'Movements': 'الحركات',
  'Stock movement': 'حركة مخزون',
  'On the board': 'على اللوحة',
  'Drafts': 'مسودات',
  'Came down': 'تم الإزالة',
  'Not up yet': 'لم ينشر بعد',
  'Nobody else can see it yet.': 'لا يستطيع أحد آخر رؤيته بعد.',
  'Taken down.': 'تم الإزالة.',
  'Goes up': 'ينشر في',
  '7 days': '7 أيام',
  '30 days': '30 يومًا',
  '90 days': '90 يومًا',
  '13 months': '13 شهرًا',
  'Pull changes': 'سحب التغييرات',
  'Capture figures': 'تسجيل الأرقام',
  'Abandoned checkouts': 'طلبات مغادرة لم تُكمل',
  'Store credit': 'رصيد المتجر',
  'Register webhooks': 'تسجيل إشعارات الويب',
  'Loading sync health': 'جارٍ تحميل حالة المزامنة',
  'Sync health unavailable': 'حالة المزامنة غير متاحة',
  'The job did not finish.': 'لم يتم إنهاء المهمة.',
  'finished.': 'تم الانتهاء.',
  'running': 'قيد التشغيل',
  'idle': 'خامل',
  'healthy': 'سليم',
  'lagging': 'متأخر',
  'error': 'خطأ',
  'Customers': 'العملاء',
  'Sales snapshots': 'لقطات المبيعات',
  'Session snapshots': 'لقطات الجلسات',
  'Webhook subscriptions': 'اشتراكات الويب هوك',

  'Department queue': 'قائمة القسم',
  'All tickets': 'جميع التذاكر',
  'Tasks & tickets': 'المهام والتذاكر',
  'Assigned to me': 'المسندة إلي',
  'My requests': 'طلباتي',
  "I'm on it": 'أنا أعمل عليها',
  'My department': 'قسمي',
  'For review': 'للمراجعة',
  'Being carried out': 'جارٍ تنفيذها',
  'Done': 'تم',
  'Plan': 'تخطيط',
  'Hold': 'تعليق',
  'Start': 'بدء',
  'Resume': 'استئناف',
  'On hold': 'معلّقة',
  'Planned': 'مخططة',
  'Assigned': 'تم تعيينها',
  'Waiting on others': 'بانتظار الآخرين',

  'Order Template': 'نموذج الطلب',
  'Patch Log': 'سجل الدفعات',
  'In Quality': 'في قسم الجودة',
  'Receiving From Quality': 'استلام من الجودة',
  'Templates': 'القوالب',
  'The register': 'السجل',
  'Every roll': 'جميع الألفات',
  'No rolls': 'لا توجد لفات',
  'The register is empty.': 'السجل فارغ.',
  'CTN': 'رقم الكرتون',
  'Metres': 'الأمتار',
  'Received': 'تم الاستلام',
  'Issued': 'تم الإصدار',
  'Reported': 'تم التقرير',
  'Delivered': 'تم التسليم',
  'Reading quality batches': 'جارٍ قراءة دفعات الجودة',
  'Waiting for warehouse': 'بانتظار المستودع',

  'Account requests': 'طلبات الحسابات',
  'Approve account': 'اعتماد الحساب',
  'Request': 'طلب',
  'Requests': 'الطلبات',
  'Account': 'الحساب',

  'via your role': 'من خلال دورك',
  'granted to you': 'ممنوح لك',
  'administrator': 'مسؤول',
  'Bank Account Number': 'رقم حساب بنكي',
  'IBAN': 'رقم حساب دولي',
  'Vendors Payments': 'مدفوعات الموردين',
  'Nothing yet': 'لا يوجد شيء حتى الآن',
  'Nothing waiting': 'لا توجد عناصر قيد الانتظار',
  'Nothing matches that.': 'لا توجد نتائج مطابقة.',
  'That did not work.': 'تعذر تنفيذ ذلك.',
  'Creating…': 'جارٍ الإنشاء…',
  'Saving…': 'جارٍ الحفظ…',
  'Sending…': 'جارٍ الإرسال…',
  'Choose…': 'اختر…',
  'Issue reported': 'تم تسجيل المشكلة',
  'Add a task to the board': 'إضافة مهمة إلى اللوحة',
  'Who does it': 'من ينفذها',
  "Choose somebody…": 'اختر شخصًا…',
  'Due by': 'الموعد النهائي',
  'Work starts the moment you choose somebody, and they are emailed.':
    'يبدأ العمل عند تعيين الشخص، ويتم إرسال بريد إلكتروني إليه.',
  'Comment on orders': 'تعليق على الطلبات',
  'The comment': 'التعليق',
  'Goes on every order in the file, published to its Shopify note.':
    'يُضاف إلى كل طلب في الملف وينشر في ملاحظة Shopify.',
  'The orders': 'الطلبات',
  '.xlsx or .csv, references in the first column':
    'ملفات .xlsx أو .csv، والمراجع في العمود الأول',
  'Nothing was published.': 'لم يتم نشر أي شيء.',
  'These were not published:': 'لم يتم نشر هذه العناصر:',
  'Pictures or documents': 'صور أو مستندات',
  'JPEG, PNG, WebP or PDF. Up to 10 MB each.':
    'JPEG أو PNG أو WebP أو PDF. بحد أقصى 10 ميغابايت لكل ملف.',
  'Uploading…': 'جارٍ الرفع…',
  'Title': 'العنوان',
  'What this is about': 'موضوع الإعلان',
  'Anything people need to know.': 'أي معلومات يحتاج الآخرون إلى معرفتها.',
  'How long it stays up': 'مدة بقائه منشورًا',
  'Let people comment': 'السماح بتعليقات الأشخاص',
  'Seen it': 'رأيته',
  'Love this': 'أعجبني',
  'Congratulations': 'تهنئة',
  'Well done': 'أحسنت',
  'Thank you': 'شكرًا',
  'Made me laugh': 'أضحكني',
  'Sorry to hear it': 'أسف لسماع ذلك',
  'Thinking about it': 'أفكر في ذلك',
  'React to this': 'التفاعل مع هذا',
  'Be the first to say something.': 'كن أول من يكتب تعليقًا.',
  'The last note did not reach Shopify.': 'لم تصل آخر ملاحظة إلى Shopify.',
  'No notes on this order yet.': 'لا توجد ملاحظات لهذا الطلب بعد.',
  'What should the rest of the team know?': 'ماذا يجب أن يعرف باقي الفريق؟',
  'You can read these notes but not add to them.':
    'يمكنك قراءة هذه الملاحظات وليس إضافة ملاحظات جديدة.',
  'Previous day': 'اليوم السابق',
  'Next day': 'اليوم التالي',
  'Booked': 'محجوز',
  'Buffer': 'وقت احتياطي',
  'Past': 'منتهٍ',
  'Nothing booked': 'لا توجد حجوزات',
  'This time has already passed and can no longer be booked.':
    'انتهى هذا الوقت ولا يمكن حجزه.',
  'Unavailable': 'غير متاح',
  'pending': 'قيد الانتظار',
  'Nothing yet.': 'لا يوجد شيء بعد.',
  'Add images or PDFs': 'إضافة صور أو ملفات PDF',
  'Open full size': 'فتح بالحجم الكامل',
  'Photographs': 'الصور',
  'what arrived, and its state': 'ما تم استلامه وحالته',
  'Nothing attached.': 'لا توجد مرفقات.',
  'Portal': 'البوابة',
  'soon': 'قريبًا',
  'Previous week': 'الأسبوع السابق',
  'Next week': 'الأسبوع التالي',
  'Prev': 'السابق',
  'Already passed': 'انتهى بالفعل',
  'Nobody has reviewed it yet': 'لم يراجعها أحد بعد',
  'Fast-tracked — skips review': 'مسار سريع — يتجاوز المراجعة',
  'Nothing here': 'لا يوجد شيء هنا',
  'Searching…': 'جارٍ البحث…',
  'View': 'عرض',
  'Assignee': 'المكلف',
  'Due date': 'تاريخ الاستحقاق',
  'Priority': 'الأولوية',
  'Status': 'الحالة',
  'Waiting': 'في الانتظار',
  'Decided': 'تم القرار',
  'Nothing decided yet': 'لم يتم اتخاذ قرارات بعد',
  'Requests for accounts will appear here.': 'ستظهر هنا طلبات إنشاء الحسابات.',
  'Loading requests': 'جارٍ تحميل الطلبات',
  'That could not be saved.': 'تعذر حفظ ذلك.',
  'Asked': 'تم الطلب',
  'Decide': 'اتخاذ قرار',
  'Outcome': 'النتيجة',
  'By': 'بواسطة',
  'When': 'متى',
  'Refuse': 'رفض',
  'Refused': 'مرفوض',
  'The notice board': 'لوحة الإعلانات',
  'Write a notice': 'كتابة إعلان',
  'Everything that exists, not just what is up.': 'كل الإعلانات الموجودة، وليس فقط المنشورة.',
  'Notice': 'الإعلان',
  'Standing': 'الحالة',
  'Written': 'تمت كتابته',
  'Delete it': 'حذفه',
  'This page is for whoever looks after the notice board.':
    'هذه الصفحة تخص من يدير لوحة الإعلانات.',
  'Everyone can see these right now.': 'يمكن للجميع رؤية هذه الإعلانات الآن.',
  'Not published. Only you can see these.': 'غير منشورة. أنت وحدك يمكنك رؤيتها.',
  'Published, but past the date they were set to end.':
    'تم نشرها، لكن انتهت صلاحية عرضها.',
  'Taken down on purpose. Can be put back up.':
    'تم إزالتها عمدًا. يمكن إعادة نشرها.',
  'New': 'جديد',
  'With quality': 'مع قسم الجودة',
  'Worood Quality': 'جودة Worood',
  'Workshop Quality': 'جودة الورشة',
  'Newest first': 'الأحدث أولًا',
  'Oldest first': 'الأقدم أولًا',
  'nothing here': 'لا يوجد شيء هنا',
  'lines short': 'أسطر ناقصة',
  'no shortage': 'لا يوجد نقص',
  'Workshop': 'الورشة',
  'Reconciliation': 'المطابقة',
  'History': 'السجل',
  'Receive rolls': 'استلام الألفات',
  'Reading the roll register': 'جارٍ قراءة سجل الألفات',
  'Fabric from arrival to a closed job order.':
    'الخام من الاستلام حتى إغلاق أمر التشغيل.',
  'Cutting': 'القص',
  'In Production': 'قيد الإنتاج',
  'Finish Rolls': 'إنهاء الألفات',
  'Printed': 'مطبوعة',
  'Bamboo Innercap': 'بامبو داخلي',
  'Bamboo Plain': 'بامبو عادي',
  'Other': 'أخرى',
  'Awaiting assignment': 'بانتظار التعيين',
  'Unassigned': 'غير مسند',
  'Blocked': 'متوقف',
  'Changes requested': 'مطلوب تعديلات',
  'Changes': 'التعديلات',
  'Not accepted': 'غير مقبول',
  'Delayed': 'متأخر',
  'Carrying out': 'جارٍ التنفيذ',
  'Waiting on another team': 'بانتظار فريق آخر',
  'Changed': 'تم التغيير',
  'Low': 'منخفض',
  'Normal': 'عادي',
  'High': 'مرتفع',
  'Urgent': 'عاجل',
  'Via your role': 'من خلال دورك',
  'Granted to you': 'ممنوح لك',
  'Administrator': 'مسؤول',
  'Good': 'جيد',
  'A day': 'يوم',
  'A week': 'أسبوع',
  'Three weeks': 'ثلاثة أسابيع',
  'A quarter': 'ثلاثة أشهر',
  'Until taken down': 'حتى الإزالة',
  'Who does it, and by when?': 'من ينفذها ومتى؟',
  'is planned': 'مخطط',
  'is on hold': 'معلّق',
  'Start it': 'بدء التنفيذ',
  'That file could not be removed.': 'تعذر إزالة هذا الملف.',
  'The room is full': 'الغرفة ممتلئة',
  'Type a name or e-mail': 'اكتب اسمًا أو بريدًا إلكترونيًا',
  'No order references in the first column of that file.':
    'لا توجد مراجع طلبات في العمود الأول من الملف.',
  'That file could not be read. A .xlsx or .csv with the references in the first column.':
    'تعذر قراءة الملف. استخدم ملفًا بصيغة .xlsx أو .csv والمراجع في العمود الأول.',
  'That could not be started.': 'تعذر بدء ذلك.',
  'References in the first column': 'المراجع في العمود الأول',
  'Nothing to export yet': 'لا يوجد شيء لتصديره بعد',
  'The notice could not be saved.': 'تعذر حفظ الإعلان.',
  'The pictures could not be uploaded.': 'تعذر رفع الصور.',
  'That picture could not be removed.': 'تعذر إزالة هذه الصورة.',
  'The note could not be added.': 'تعذر إضافة الملاحظة.',
  'Nothing matches': 'لا توجد نتائج مطابقة',
  'free to book': 'متاح للحجز',
  'Loading the week': 'جارٍ تحميل الأسبوع',
  'is this room free at two': 'هل هذه الغرفة متاحة الساعة الثانية',
  'Planned for': 'مخطط له',
  'No tickets here.': 'لا توجد تذاكر هنا.',
  'Attach a photo': 'إرفاق صورة',
  'could not be uploaded': 'تعذر رفعه',
  'The file could not be uploaded.': 'تعذر رفع الملف.',
  'That could not be removed.': 'تعذر إزالته.',
  'Could not retire that room.': 'تعذر إغلاق هذه الغرفة.',
  'Could not save this room.': 'تعذر حفظ هذه الغرفة.',
  'Could not reply.': 'تعذر الرد.',
  'Could not cancel this booking.': 'تعذر إلغاء هذا الحجز.',
  'Keep it': 'الاحتفاظ به',
  'Nothing in the past': 'لا يوجد شيء سابق',
  'Your calendar is clear': 'تقويمك فارغ',
  'When you need a room': 'عندما تحتاج إلى غرفة',
  "Can't make it": 'لا أستطيع الحضور',
  'I was invited': 'تمت دعوتي',
  'One invitation is waiting for you': 'توجد دعوة واحدة بانتظارك',
  'Nothing is on you at the moment.': 'لا توجد مهام مسندة إليك حاليًا.',
  'Send for review': 'إرسال للمراجعة',
  'Loading the news': 'جارٍ تحميل الأخبار',
  'Announcements, events and the people behind them.':
    'الإعلانات والأحداث والأشخاص وراءها.',
  'When HR posts something, it will show here and on the home page.':
    'عندما تنشر الموارد البشرية شيئًا، سيظهر هنا وفي الصفحة الرئيسية.',
  'Not showing': 'غير معروض',
  'Replies are turned off for this announcement.':
    'تم إيقاف الردود لهذا الإعلان.',
  'It has never been published, so nobody has seen it. This cannot be undone.':
    'لم يُنشر من قبل، ولذلك لم يره أحد. لا يمكن التراجع عن هذا.',
  'Kept at the top': 'مثبت في الأعلى',
  'Pin to top': 'تثبيت في الأعلى',
  'Use the button above.': 'استخدم الزر أعلاه.',
  'No screen at this address': 'لا توجد صفحة لهذا العنوان',
  'Back to home': 'العودة إلى الرئيسية',
  'No orders in those dates.': 'لا توجد طلبات في تلك التواريخ.',
  'No orders on this page': 'لا توجد طلبات في هذه الصفحة',
  'Try an earlier page.': 'حاول صفحة سابقة.',
  'Customer columns are withheld from your account.':
    'أعمدة العملاء مخفية عن حسابك.',
  'The export could not be taken.': 'تعذر تنفيذ التصدير.',
  'Nothing new since the last export.': 'لا يوجد جديد منذ آخر تصدير.',
  'Could not change it.': 'تعذر تغيير ذلك.',
  'Could not change access.': 'تعذر تغيير الصلاحيات.',
  'Could not save.': 'تعذر الحفظ.',
  'Could not delete.': 'تعذر الحذف.',
  'Pick someone from the list': 'اختر شخصًا من القائمة',
  'Name, e-mail or job title': 'الاسم أو البريد الإلكتروني أو المسمى الوظيفي',
  'Reset to role': 'إعادة التعيين حسب الدور',
  'Block for them': 'حظر له',
  'No individual overrides. Access is entirely by role.':
    'لا توجد صلاحيات فردية خاصة. الوصول يتم حسب الدور فقط.',
  'Add someone from the directory': 'إضافة شخص من دليل الموظفين',
  'Choose a person': 'اختر شخصًا',
  'The platform': 'المنصة',
  'Pick a role from the list': 'اختر دورًا من القائمة',
  'What this role is for': 'غرض هذا الدور',
  'Who holds it': 'من لديه هذا الدور',
  'Assign it from the People screen.': 'قم بإسناد الدور من شاشة الموظفين.',
  'Move its holders to another role first': 'انقل الحاملين إلى دور آخر أولًا',
  'Ask for an account': 'طلب حساب',
  'Book a room': 'حجز غرفة',
  'When do you need it?': 'متى تحتاج الغرفة؟',
  'A time, a length, and anything the room must have':
    'وقت الاجتماع ومدته وأي متطلبات يجب أن تتوافر في الغرفة',
  'Starting at': 'يبدأ في',
  'Free at that time instead': 'اختر وقتًا آخر متاحًا',
  'Not available': 'غير متاح',
  'Nothing else free in this room today.': 'لا توجد أوقات أخرى متاحة في هذه الغرفة اليوم.',
  'What is it for': 'ما الغرض منه',
  'This room is held for approval. The slot is reserved for you in the meantime.':
    'هذه الغرفة بانتظار الموافقة. تم حجز الوقت لك مؤقتًا.',
  'Could not complete the booking.': 'تعذر إكمال الحجز.',
  'This dashboard is empty. Add widgets from the catalogue.':
    'هذه اللوحة فارغة. أضف أدوات من الكتالوج.',
  'What this view is for.': 'الغرض من هذا العرض.',
  'Requests you raise will appear here with their progress.':
    'ستظهر هنا الطلبات التي تقدم بها مع حالة تقدمها.',
  'Totals by department': 'الإجماليات حسب القسم',
  'When something needs your approval it will appear here.':
    'عندما يحتاج شيء إلى اعتمادك سيظهر هنا.',
  'Waiting on': 'بانتظار',
  'Needed by': 'مطلوب بحلول',
  'How should the money be sent?': 'كيف يجب إرسال المبلغ؟',
  'Beneficiary (the account holder)': 'المستفيد (صاحب الحساب)',
  'Choose the supplier first.': 'اختر المورد أولًا.',
  'Add what is being bought.': 'أضف المواد أو الخدمات المراد شراؤها.',
  'Every line needs a rate.': 'كل بند يحتاج إلى سعر.',
  'The request': 'الطلب',
  'Add a note': 'إضافة ملاحظة',
  'Ask for a change': 'طلب تعديل',
  'Why is the change needed?': 'لماذا هذا التعديل مطلوب؟',
  'With the manager': 'عند المدير',
  'With Finance': 'عند قسم المالية',
  'Kind of spending': 'نوع الإنفاق',
  'Not for petty cash': 'ليس من المصروفات النثرية',
  'Attach a file': 'إرفاق ملف',
  'The payment could not be recorded.': 'تعذر تسجيل الدفعة.',
  'Paid from': 'مدفوع من',
  'To Pay': 'للدفع',
  'Send to': 'إرسال إلى',
  'What is being bought': 'ما الذي يتم شراؤه',
  'Mark as received': 'تحديده كمستلم',
  'The figures below are the corrected ones.': 'البيانات أدناه هي القيم المصححة.',
  'Working out the month': 'جارٍ حساب الشهر',
  'Nothing to forecast for this month.': 'لا توجد توقعات لهذا الشهر.',
  'Home screen restored to its default layout.':
    'تمت استعادة تخطيط الصفحة الرئيسية إلى الوضع الافتراضي.',
  'Cash on Delivery (COD)': 'الدفع عند الاستلام',
  'No successful payment transaction on this order':
    'لا توجد عملية دفع ناجحة لهذا الطلب',
  'Give both dates, or neither.': 'أدخل التاريخين معًا أو لا تدخل أيًا منهما.',
  'Flagged as a test order by the shop.': 'تم وضع علامة اختبار على الطلب من المتجر.',
  'Runs a department': 'يدير قسمًا',
  'Has never signed in': 'لم يسجل الدخول من قبل',
  'Set a password': 'تعيين كلمة مرور',
  'Could not set the password.': 'تعذر تعيين كلمة المرور.',
  'Could not create the account.': 'تعذر إنشاء الحساب.',
  'Everything their roles add up to': 'جميع الصلاحيات المجمعة من أدوار المستخدم',
  'Not assigned': 'غير مسند',
  'Granted individually, and by their role': 'ممنوح له فرديًا ومن خلال دوره',
  'Open or closed': 'مفتوح أو مغلق',
  'Search by title or reference, e.g. TK-1042':
    'البحث بالعنوان أو المرجع، مثل TK-1042',
  'Waiting for you to assign': 'بانتظار تعيينك',
  'Every ticket raised to your department has somebody on it.':
    'لكل تذكرة مرفوعة إلى قسمك شخص مكلف بها.',
  'Raise one when you need something from a colleague or another department.':
    'قدّم طلبًا عندما تحتاج إلى شيء من زميل أو قسم آخر.',
  'Could not raise it.': 'تعذر تقديم الطلب.',
  'Replace the fridge thermostat in the cold room':
    'استبدال ترموستات الثلاجة في غرفة التبريد',
  'This one is for me.': 'هذا الطلب لي.',
  'Images and PDFs': 'الصور وملفات PDF',
  'Fast-track it.': 'تسريع المسار.',
  'Raise it': 'تقديم الطلب',
  'Nobody has looked at these yet. Plan one, park it, or cancel it.':
    'لم يراجع أحد هذه الطلبات بعد. خطط لها أو علّقها أو ألغها.',
  'Nothing new has come in.': 'لم تصل طلبات جديدة.',
  'Nothing is scheduled.': 'لا توجد طلبات مجدولة.',
  'Parked with a reason. Resume puts it straight into progress.':
    'معلّق بسبب محدد. الاستئناف يعيدها مباشرة إلى التنفيذ.',
  'Nothing is parked.': 'لا توجد طلبات معلقة.',
  'Requested by': 'مقدم الطلب',
  'Asked of us by': 'مطلوب منا من',
  'When should this be worked on?': 'متى يجب العمل عليها؟',
  'Why is it on hold?': 'لماذا تم تعليقها؟',
  'Why is it being cancelled?': 'لماذا يتم إلغاؤها؟',
  'Who picks it back up, and by when?': 'من يستأنفها ومتى؟',
  'Who starts it, and by when?': 'من يبدأها ومتى؟',
  'Due by (optional)': 'الموعد النهائي (اختياري)',
  'Do it': 'تنفيذ',
  'Opening the board': 'جارٍ فتح اللوحة',
  'This board is for department managers': 'هذه اللوحة لمديري الأقسام',
  'Standing in': 'النيابة',
  'Which of your departments': 'أي الأقسام التابعة لك',
  'Asked for by': 'مطلوب من',
  'Narrow to what one department asked of this one':
    'تصفية الطلبات الموجهة لقسم محدد',
  'Raised for you': 'مرفوع إليك',
  'Work assigned to you appears here.': 'ستظهر هنا الأعمال المسندة إليك.',
  'You have not asked for anything': 'لم تطلب أي شيء',
  'Tickets you raise stay here until they are closed.':
    'تظل التذاكر التي تنشئها هنا حتى يتم إغلاقها.',
  'Pieces in stock': 'قطع في المخزون',
  'Out of stock': 'نفد المخزون',
  'Building the charts': 'جارٍ إنشاء الرسوم',
  'Stock in and out — last 60 days': 'الوارد والصادر — آخر 60 يومًا',
  'Stock by warehouse': 'المخزون حسب المستودع',
  'Nothing is being written to Scarves Inventory.':
    'لا يتم كتابة أي شيء حاليًا إلى Scarves Inventory.',
  'Where the pieces are': 'أين توجد القطع',
  'Reading the warehouses': 'جارٍ قراءة المستودعات',
  'What is inside each one, and how it is split.':
    'محتويات كل مستودع وكيفية توزيعها.',
  'Reading the warehouse': 'جارٍ قراءة المستودع',
  'Where is it?': 'أين هو؟',
  'Pick an item to see how much of it sits in each warehouse.':
    'اختر صنفًا لمعرفة الكمية الموجودة في كل مستودع.',
  'Looking it up': 'جارٍ البحث',
  'None in stock': 'لا يوجد مخزون',
  'This item has no balance in any counted warehouse.':
    'لا يوجد رصيد لهذا الصنف في أي من المستودعات المحسوبة.',
  'Working out the pace': 'جارٍ حساب معدل الحركة',
  'Nothing to forecast': 'لا توجد بيانات للتنبؤ',
  'Stock by collection': 'المخزون حسب المجموعة',
  'Items with the most pieces sitting in WH-04.':
    'الأصناف التي تحتوي على أكبر عدد من القطع في WH-04.',
  'Nothing in WH-04': 'لا يوجد مخزون في WH-04',
  'No defects on hand.': 'لا توجد عيوب في المخزون.',
  'On hand': 'المتوفر',
  'Made of': 'مصنوع من',
  'Where it is': 'مكانه',
  'Reading the ledger': 'جارٍ قراءة دفتر الحركات',
  'No movements for this item.': 'لا توجد حركات لهذا الصنف.',
  'Find a movement': 'البحث عن حركة',
  'Try a different reference.': 'جرّب مرجعًا آخر.',
  'Create an item': 'إنشاء صنف',
  'That could not be created.': 'تعذر إنشاء الصنف.',
  'The three parts': 'الأجزاء الثلاثة',
  'What the sheet will make': 'ما سيُنشئه جدول البيانات',
  'Name in the ledger': 'الاسم في دفتر المخزون',
  'Create the item': 'إنشاء الصنف',
  'What to print': 'ما المراد طباعته',
  'Make the labels': 'إنشاء الملصقات',
  'Reading the document register': 'جارٍ قراءة سجل المستندات',
  'Serials appear here as papers are reserved.':
    'تظهر الأرقام التسلسلية هنا عند حجز المستندات للطباعة.',
  'Reading the last patch': 'جارٍ قراءة آخر دفعة',
  'Out of': 'خارج من',
  'Add an order': 'إضافة طلب',
  'Looking it up…': 'جارٍ البحث…',
  'Add to patch': 'إضافة إلى الدفعة',
  'Save the patch': 'حفظ الدفعة',
  'What to make': 'ما المراد تصنيعه',
  'The numbers': 'الأرقام',
  'Pieces to make': 'قطع المراد تصنيعها',
  'Nothing to make': 'لا يوجد شيء للتصنيع',
  'Working out the cost': 'جارٍ حساب التكلفة',
  'Where the cost comes from': 'مصدر التكلفة',
  'Costs and prices': 'التكاليف والأسعار',
  'Monthly overheads, the fabric rate, and what a piece sells for.':
    'المصروفات الشهرية وسعر القماش وسعر بيع القطعة.',
  'Rent, a month': 'الإيجار شهريًا',
  'Utilities, a month': 'المرافق شهريًا',
  'Fabric, a metre': 'القماش بالمتر',
  'Selling price, by grade': 'سعر البيع حسب الدرجة',
  'Save the constants': 'حفظ القيم الثابتة',
  'Post a movement': 'ترحيل حركة',
  'Loading the warehouse': 'جارٍ تحميل المستودع',
  'That could not be posted.': 'تعذر ترحيل الحركة.',
  'Kind of movement': 'نوع الحركة',
  'Out of which warehouse': 'من أي مستودع',
  'Find an item…': 'ابحث عن صنف…',
  'It goes to the warehouse sheet.': 'ستسجل في جدول المستودع.',
  'Post it': 'ترحيله',
  'Count and confirm': 'العد والتأكيد',
  'Confirm and move the stock': 'التأكيد ونقل المخزون',
  'Reason, if sending it back': 'السبب عند الإعادة',
  'Nothing sold in that range': 'لا توجد مبيعات في هذه الفترة',
  'Try a wider one.': 'جرّب فترة أكبر.',
  'Sold, day by day': 'المبيعات يومًا بيوم',
  'By warehouse': 'حسب المستودع',
  'By collection': 'حسب المجموعة',
  'Days of cover': 'أيام التغطية',
  'Log an issue': 'تسجيل مشكلة',
  'Log a return issue': 'تسجيل مشكلة مرتجع',
  'What was shipped': 'ما تم شحنه',
  'Log it': 'تسجيلها',
  'Reading the patch log': 'جارٍ قراءة سجل الدفعات',
  'Patch number or person': 'رقم الدفعة أو الشخص',
  'Something wrong? Write it here — comments can never be deleted':
    'هل توجد مشكلة؟ اكتبها هنا — لا يمكن حذف التعليقات',
  'Close conversation': 'إغلاق المحادثة',
  'Notes on this patch.': 'ملاحظات على هذه الدفعة.',
  'Close the order': 'إغلاق الأمر',
  'That could not be closed.': 'تعذر إغلاق الأمر.',
  'The workshop has not reported production on this order.':
    'لم يورد الورشة إنتاجًا لهذا الأمر بعد.',
  'Reading the job orders': 'جارٍ قراءة أوامر التشغيل',
  'Reading the workshop': 'جارٍ قراءة الورشة',
  'Filter by name, code or CTN': 'تصفية حسب الاسم أو الكود أو رقم الكرتون',
  'No rolls in the list yet.': 'لا توجد لفات في القائمة بعد.',
  'Taking a serial…': 'جارٍ حجز رقم تسلسلي…',
  'Take a serial and print': 'حجز رقم تسلسلي وطباعة',
  'Reading the patch': 'جارٍ قراءة الدفعة',
  'No orders are booked against it.': 'لا توجد طلبات مسجلة عليها.',
  'ENTERED BY': 'مدخل بواسطة',
  'IN_PROGRESS': 'قيد التنفيذ',
  'IN REVIEW': 'قيد المراجعة',
  'TO_DO': 'للقيام به',
  'DONE': 'مكتمل',
  'ASSIGNED': 'مُسنَد',
  'REASSIGNED': 'أعيد تعيينه',
  'PENDING': 'قيد الانتظار',
  'PUBLISHED': 'تم النشر',
  'CONFIRMED': 'مؤكد',
  'CANCELLED': 'ملغي',
  'CANCELED': 'ملغي',
  'WAITING': 'في الانتظار',
  'COMPLETED': 'مكتمل',
  'ON_HOLD': 'معلّق',
  'APPROVED': 'موافق عليه',
  'REJECTED': 'مرفوض',
  'DRAFT': 'مسودة',
  'ARCHIVED': 'مؤرشف',
  'PAID': 'مدفوع',
  'UNPAID': 'غير مدفوع',
  'PARTIAL': 'جزئي',
  'OVERDUE': 'متأخر',
  'HOLD': 'تعليق',
  'Started': 'تم البدء',
  'Pause': 'إيقاف مؤقت',
  'Assign': 'تعيين',
  'Review': 'مراجعة',
  'Resolve': 'حل',
  'Due': 'مستحق',
  'Overdue': 'متأخر',
  'In progress': 'قيد التنفيذ',
  'In review': 'قيد المراجعة',
  'Completed': 'مكتمل',
  'Canceled': 'ملغي',
  'Confirmed': 'مؤكد',
};

export function translateText(text: string, locale: 'en' | 'ar'): string {
  if (locale !== 'ar') return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (AR_TEXT[trimmed]) return AR_TEXT[trimmed];

  let translated = trimmed
    .replace(/^Loading (.+)$/i, 'جارٍ تحميل $1')
    .replace(/^Reading (.+)$/i, 'جارٍ قراءة $1')
    .replace(/^Could not (.+)$/i, 'تعذر $1')
    .replace(/^That could not be (.+)$/i, 'تعذر $1')
    .replace(/^No (.+)$/i, 'لا يوجد $1')
    .replace(/^Nothing (.+)$/i, 'لا يوجد $1')
    .replace(/^Search by (.+)$/i, 'البحث حسب $1')
    .replace(/^Add (.+)$/i, 'إضافة $1')
    .replace(/^Create (.+)$/i, 'إنشاء $1')
    .replace(/^Choose (.+)$/i, 'اختر $1')
    .replace(/^Mark (.+)$/i, 'تحديد $1')
    .replace(/^Open (.+)$/i, 'فتح $1')
    .replace(/^Close (.+)$/i, 'إغلاق $1')
    .replace(/^Cancel (.+)$/i, 'إلغاء $1')
    .replace(/^Remove (.+)$/i, 'إزالة $1')
    .replace(/^Delete (.+)$/i, 'حذف $1')
    .replace(/^Save (.+)$/i, 'حفظ $1')
    .replace(/^Update (.+)$/i, 'تحديث $1')
    .replace(/^Approve (.+)$/i, 'اعتماد $1')
    .replace(/^Reject (.+)$/i, 'رفض $1')
    .replace(/^Confirm (.+)$/i, 'تأكيد $1')
    .replace(/^View (.+)$/i, 'عرض $1')
    .replace(/^Show (.+)$/i, 'عرض $1')
    .replace(/^Hide (.+)$/i, 'إخفاء $1')
    .replace(/^Filter (.+)$/i, 'تصفية $1')
    .replace(/^Refresh (.+)$/i, 'تحديث $1')
    .replace(/^Download (.+)$/i, 'تنزيل $1')
    .replace(/^Upload (.+)$/i, 'رفع $1')
    .replace(/^Print (.+)$/i, 'طباعة $1')
    .replace(/^Back to (.+)$/i, 'العودة إلى $1')
    .replace(/^Sign (.+)$/i, 'تسجيل $1')
    .replace(/\bloading\b/i, 'جارٍ التحميل')
    .replace(/\bplease wait\b/i, 'يرجى الانتظار')
    .replace(/\bnot found\b/i, 'غير موجود')
    .replace(/\bsuccessfully\b/i, 'بنجاح')
    .replace(/\bcreated\b/i, 'تم الإنشاء')
    .replace(/\bupdated\b/i, 'تم التحديث')
    .replace(/\bdeleted\b/i, 'تم الحذف')
    .replace(/\bsaved\b/i, 'تم الحفظ')
    .replace(/\bpending\b/i, 'قيد الانتظار')
    .replace(/\bapproved\b/i, 'موافق عليه')
    .replace(/\brejected\b/i, 'مرفوض')
    .replace(/\bactive\b/i, 'نشط')
    .replace(/\binactive\b/i, 'غير نشط')
    .replace(/\bdraft\b/i, 'مسودة')
    .replace(/\bpublished\b/i, 'تم النشر')
    .replace(/\barchived\b/i, 'مؤرشف')
    .replace(/\bopen\b/i, 'مفتوح')
    .replace(/\bclosed\b/i, 'مغلق')
    .replace(/\bfailed\b/i, 'فشل');

  if (translated === trimmed) return text;
  return text.replace(trimmed, translated);
}

const RTL_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'];
const ORIGINAL_TEXT = new WeakMap<Text, string>();
const ORIGINAL_ATTRIBUTES = new WeakMap<Element, Map<string, string>>();

function translateDom(root: ParentNode, locale: 'en' | 'ar') {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  for (const textNode of nodes) {
    const previous = ORIGINAL_TEXT.get(textNode);
    if (previous === undefined) {
      ORIGINAL_TEXT.set(textNode, textNode.data);
    } else {
      const expected = locale === 'ar' ? translateText(previous, 'ar') : previous;
      /* React may reuse a text node for a new label; keep its new source text. */
      if (textNode.data !== expected) ORIGINAL_TEXT.set(textNode, textNode.data);
    }
    const original = ORIGINAL_TEXT.get(textNode) ?? textNode.data;
    const value = locale === 'ar' ? translateText(original, 'ar') : original;
    if (value !== textNode.data) textNode.data = value;
  }

  root.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of RTL_ATTRIBUTES) {
      let originals = ORIGINAL_ATTRIBUTES.get(element);
      if (!originals) ORIGINAL_ATTRIBUTES.set(element, originals = new Map());
      const current = element.getAttribute(attribute);
      if (!originals.has(attribute) && current) originals.set(attribute, current);
      const original = originals.get(attribute);
      if (!original) continue;
      const value = locale === 'ar' ? translateText(original, 'ar') : original;
      if (current !== value) element.setAttribute(attribute, value);
    }
  });
}

export function I18nRuntime({ children }: { children: ReactNode }) {
  const { locale } = useAppearance();
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = document.body;
    rootRef.current = root;
    translateDom(root, locale);
  }, [locale]);

  useEffect(() => {
    const root = document.body;
    rootRef.current = root;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData' && record.target) {
          translateDom(record.target.parentNode ?? document, locale);
        } else if (record.type === 'childList') {
          record.addedNodes.forEach((added) => {
            if (added.nodeType === Node.TEXT_NODE) {
              translateDom(added.parentNode ?? document, locale);
            } else if (added instanceof Element) {
              translateDom(added, locale);
            }
          });
        } else if (record.type === 'attributes' && record.target instanceof Element) {
          translateDom(record.target, locale);
        }
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: RTL_ATTRIBUTES,
    });
    return () => observer.disconnect();
  }, [locale]);

  return children;
}