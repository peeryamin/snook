PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY,
  name TEXT,
  type TEXT NOT NULL CHECK (type IN ('ENGLISH','FRENCH')),
  hourly_rate INTEGER NOT NULL,
  minimum_charge INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','OCCUPIED','MAINTENANCE')),
  light_on INTEGER NOT NULL DEFAULT 0,
  last_maintenance INTEGER DEFAULT NULL,
  total_hours_played INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  table_id INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  duration_ms INTEGER DEFAULT 0,
  billed_minutes INTEGER DEFAULT 0,
  amount INTEGER DEFAULT 0,
  is_friendly INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT,
  customer_phone TEXT,
  player_one_name TEXT,
  player_two_name TEXT,
  loser TEXT CHECK (loser IN ('PLAYER_ONE','PLAYER_TWO')),
  food_charge INTEGER NOT NULL DEFAULT 0,
  tip INTEGER NOT NULL DEFAULT 0,
  food_items TEXT,
  payer_name TEXT,
  notes TEXT,
  paused_ms INTEGER NOT NULL DEFAULT 0,
  last_resume_time INTEGER,
  break_count INTEGER DEFAULT 0,
  payment_method TEXT DEFAULT 'CASH' CHECK (payment_method IN ('CASH','UPI','CARD')),
  payment_status TEXT DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING','PAID','PARTIAL')),
  discount_percent INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(table_id) REFERENCES tables(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_table_time ON sessions(table_id, start_time);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_sessions_customer ON sessions(customer_name, customer_phone);

CREATE TABLE IF NOT EXISTS daily_players (
  id INTEGER PRIMARY KEY,
  player_code TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  sessions_count INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(player_code, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_players_date ON daily_players(date);
CREATE INDEX IF NOT EXISTS idx_daily_players_name ON daily_players(name);

CREATE TABLE IF NOT EXISTS daily_summaries (
  date TEXT PRIMARY KEY,
  total_earnings INTEGER NOT NULL DEFAULT 0,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  friendly_games INTEGER NOT NULL DEFAULT 0,
  english_earnings INTEGER NOT NULL DEFAULT 0,
  french_earnings INTEGER NOT NULL DEFAULT 0,
  cash_earnings INTEGER NOT NULL DEFAULT 0,
  upi_earnings INTEGER NOT NULL DEFAULT 0,
  card_earnings INTEGER NOT NULL DEFAULT 0,
  peak_hour TEXT DEFAULT NULL,
  avg_session_duration INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT,
  total_sessions INTEGER DEFAULT 0,
  total_spent INTEGER DEFAULT 0,
  membership_type TEXT DEFAULT 'REGULAR' CHECK (membership_type IN ('REGULAR','VIP','PREMIUM')),
  discount_percent INTEGER DEFAULT 0,
  loyalty_points INTEGER DEFAULT 0,
  membership_start_date INTEGER,
  membership_expiry_date INTEGER,
  membership_status TEXT DEFAULT 'ACTIVE' CHECK (membership_status IN ('ACTIVE','EXPIRED','SUSPENDED')),
  id_card_number TEXT,
  photo_url TEXT,
  date_of_birth INTEGER,
  address TEXT,
  emergency_contact TEXT,
  last_visit INTEGER,
  notes TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Membership tiers configuration
CREATE TABLE IF NOT EXISTS membership_tiers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  monthly_fee INTEGER DEFAULT 0,
  annual_fee INTEGER DEFAULT 0,
  session_discount_percent INTEGER DEFAULT 0,
  consumable_discount_percent INTEGER DEFAULT 0,
  priority_booking INTEGER DEFAULT 0, -- 1 for priority booking
  free_sessions_per_month INTEGER DEFAULT 0,
  points_multiplier REAL DEFAULT 1.0,
  min_spending_requirement INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Loyalty points transactions
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('EARNED', 'REDEEMED', 'EXPIRED', 'BONUS')),
  points INTEGER NOT NULL,
  previous_balance INTEGER NOT NULL,
  new_balance INTEGER NOT NULL,
  reference_id INTEGER, -- Could be session_id, purchase_id, etc.
  reference_type TEXT, -- 'SESSION', 'PURCHASE', 'MANUAL'
  description TEXT,
  expiry_date INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

-- Membership benefits/rewards
CREATE TABLE IF NOT EXISTS membership_rewards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('DISCOUNT', 'FREE_ITEM', 'PRIORITY_BOOKING', 'POINTS_BONUS')),
  value INTEGER, -- Discount percentage or points amount
  item_id INTEGER, -- For free items
  min_tier TEXT CHECK (min_tier IN ('REGULAR','VIP','PREMIUM')),
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Customer rewards redemptions
CREATE TABLE IF NOT EXISTS reward_redemptions (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  reward_id INTEGER NOT NULL,
  points_used INTEGER DEFAULT 0,
  redemption_date INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
  notes TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(reward_id) REFERENCES membership_rewards(id)
);

CREATE TABLE IF NOT EXISTS hardware_logs (
  id INTEGER PRIMARY KEY,
  table_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_time_ms INTEGER,
  error_message TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(table_id) REFERENCES tables(id)
);

-- Triggers for automatic timestamps
CREATE TRIGGER IF NOT EXISTS update_tables_timestamp 
  AFTER UPDATE ON tables
  BEGIN
    UPDATE tables SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

-- Users table for authentication
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY,
 username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'admin')),
 full_name TEXT NOT NULL,
 email TEXT,
 is_active INTEGER NOT NULL DEFAULT 1,
 last_login INTEGER,
 created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
 updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Sessions table for authentication
CREATE TABLE IF NOT EXISTS user_sessions (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
 FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Settings table for configurable options
CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 description TEXT,
 updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
 updated_by INTEGER,
 FOREIGN KEY(updated_by) REFERENCES users(id)
);

-- Indexes for users and sessions
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

-- Triggers for automatic timestamps
CREATE TRIGGER IF NOT EXISTS update_users_timestamp
 AFTER UPDATE ON users
 BEGIN
   UPDATE users SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
 END;

-- Insert default admin user (password: Zaid990340)
INSERT OR IGNORE INTO users (username, password_hash, role, full_name, email)
VALUES ('admin', '$2b$10$AArAs1IJmbTKMgfeTTogxeOc6JtGFlHsPjO3iQn5z/ihqZStjZY6S', 'admin', 'Administrator', 'admin@blackracks.local');

-- Insert default settings
INSERT OR IGNORE INTO settings (key, value, description) VALUES
('parlor_name', 'Black Racks Snooker Club by Zaid', 'Name of the snooker parlor'),
('default_english_rate', '300', 'Default hourly rate for English tables (in rupees)'),
('default_french_rate', '300', 'Default hourly rate for French tables (in rupees)'),
('session_timeout', '24', 'User session timeout in hours'),
('allow_friendly_games', 'true', 'Allow friendly games (no billing)'),
('auto_backup_enabled', 'true', 'Enable automatic database backups'),
('loyalty_points_per_rupee', '1', 'Loyalty points earned per rupee spent'),
('points_expiry_months', '12', 'Months until loyalty points expire');

-- Insert default membership tiers
INSERT OR IGNORE INTO membership_tiers (name, description, monthly_fee, annual_fee, session_discount_percent, consumable_discount_percent, priority_booking, free_sessions_per_month, points_multiplier, min_spending_requirement) VALUES
('REGULAR', 'Basic membership with standard benefits', 0, 0, 5, 5, 0, 0, 1.0, 0),
('VIP', 'Premium membership with enhanced benefits', 500, 5000, 15, 10, 1, 2, 1.5, 5000),
('PREMIUM', 'Elite membership with maximum benefits', 1000, 10000, 25, 15, 1, 4, 2.0, 15000);

-- Insert default membership rewards
INSERT OR IGNORE INTO membership_rewards (name, description, reward_type, value, min_tier) VALUES
('Session Discount', 'Discount on table sessions', 'DISCOUNT', 5, 'REGULAR'),
('Consumable Discount', 'Discount on food and beverages', 'DISCOUNT', 5, 'REGULAR'),
('Priority Booking', 'Book tables before regular customers', 'PRIORITY_BOOKING', 0, 'VIP'),
('Free Session', 'One free session per month', 'FREE_ITEM', 1, 'VIP'),
('Points Bonus', 'Extra loyalty points on spending', 'POINTS_BONUS', 50, 'PREMIUM');

-- Inventory Management Tables

-- Equipment inventory (cues, balls, chalk, etc.)
CREATE TABLE IF NOT EXISTS equipment_inventory (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('CUE', 'BALLS', 'CHALK', 'CLOTH', 'LIGHTS', 'OTHER')),
  description TEXT,
  total_quantity INTEGER NOT NULL DEFAULT 0,
  available_quantity INTEGER NOT NULL DEFAULT 0,
  damaged_quantity INTEGER NOT NULL DEFAULT 0,
  maintenance_quantity INTEGER NOT NULL DEFAULT 0,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 5,
  supplier_id INTEGER,
  location TEXT DEFAULT 'Main Storage',
  condition_status TEXT DEFAULT 'GOOD' CHECK (condition_status IN ('EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'DAMAGED')),
  last_inventory_check INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(supplier_id) REFERENCES vendors(id)
);

-- Consumables inventory (food, beverages, cleaning supplies)
CREATE TABLE IF NOT EXISTS consumables_inventory (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('FOOD', 'BEVERAGE', 'CLEANING', 'MAINTENANCE', 'OTHER')),
  description TEXT,
  current_stock INTEGER NOT NULL DEFAULT 0,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 10,
  supplier_id INTEGER,
  expiry_date INTEGER,
  storage_location TEXT DEFAULT 'Pantry',
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(supplier_id) REFERENCES vendors(id)
);

-- Vendors/Suppliers
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  payment_terms TEXT DEFAULT 'Net 30',
  rating INTEGER DEFAULT 5 CHECK (rating >= 1 AND rating <= 5),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Purchase orders
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL,
  order_date INTEGER NOT NULL,
  expected_delivery_date INTEGER,
  actual_delivery_date INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ORDERED', 'PARTIAL', 'DELIVERED', 'CANCELLED')),
  total_amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER DEFAULT 0,
  discount_amount INTEGER DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  approved_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(vendor_id) REFERENCES vendors(id),
  FOREIGN KEY(created_by) REFERENCES users(id),
  FOREIGN KEY(approved_by) REFERENCES users(id)
);

-- Purchase order items
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('EQUIPMENT', 'CONSUMABLE')),
  item_id INTEGER NOT NULL,
  quantity_ordered INTEGER NOT NULL,
  quantity_received INTEGER DEFAULT 0,
  unit_cost INTEGER NOT NULL,
  total_cost INTEGER NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id)
);

-- Inventory transactions (stock movements)
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (item_type IN ('EQUIPMENT', 'CONSUMABLE')),
  item_id INTEGER NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('PURCHASE', 'SALE', 'DAMAGE', 'MAINTENANCE', 'ADJUSTMENT')),
  quantity INTEGER NOT NULL,
  previous_stock INTEGER NOT NULL,
  new_stock INTEGER NOT NULL,
  reference_id INTEGER, -- Could be session_id, purchase_order_id, etc.
  reference_type TEXT, -- 'SESSION', 'PURCHASE_ORDER', 'MANUAL'
  notes TEXT,
  performed_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(performed_by) REFERENCES users(id)
);

-- Indexes for inventory tables
CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment_inventory(category);
CREATE INDEX IF NOT EXISTS idx_equipment_supplier ON equipment_inventory(supplier_id);
CREATE INDEX IF NOT EXISTS idx_consumables_category ON consumables_inventory(category);
CREATE INDEX IF NOT EXISTS idx_consumables_supplier ON consumables_inventory(supplier_id);
CREATE INDEX IF NOT EXISTS idx_vendors_active ON vendors(is_active);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor ON purchase_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_item ON inventory_transactions(item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_date ON inventory_transactions(created_at);

-- Triggers for inventory timestamps
CREATE TRIGGER IF NOT EXISTS update_equipment_timestamp
  AFTER UPDATE ON equipment_inventory
  BEGIN
    UPDATE equipment_inventory SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_consumables_timestamp
  AFTER UPDATE ON consumables_inventory
  BEGIN
    UPDATE consumables_inventory SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_vendors_timestamp
  AFTER UPDATE ON vendors
  BEGIN
    UPDATE vendors SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_purchase_orders_timestamp
  AFTER UPDATE ON purchase_orders
  BEGIN
    UPDATE purchase_orders SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

-- ===== STAFF MANAGEMENT TABLES =====

-- Staff profiles (extended user information)
CREATE TABLE IF NOT EXISTS staff_profiles (
  user_id INTEGER PRIMARY KEY,
  employee_id TEXT UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  emergency_contact TEXT,
  address TEXT,
  date_of_birth INTEGER,
  hire_date INTEGER NOT NULL,
  department TEXT DEFAULT 'Operations',
  position TEXT NOT NULL,
  hourly_rate INTEGER DEFAULT 0,
  monthly_salary INTEGER DEFAULT 0,
  employment_type TEXT DEFAULT 'Full-time' CHECK (employment_type IN ('Full-time', 'Part-time', 'Contract')),
  manager_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(manager_id) REFERENCES users(id)
);

-- Staff shifts
CREATE TABLE IF NOT EXISTS staff_shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  shift_date INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_duration INTEGER DEFAULT 30, -- minutes
  shift_type TEXT DEFAULT 'Regular' CHECK (shift_type IN ('Regular', 'Overtime', 'Holiday', 'Training')),
  notes TEXT,
  created_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

-- Attendance records
CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  date INTEGER NOT NULL,
  check_in_time INTEGER,
  check_out_time INTEGER,
  total_hours REAL DEFAULT 0,
  status TEXT DEFAULT 'Present' CHECK (status IN ('Present', 'Absent', 'Late', 'Half-day')),
  notes TEXT,
  approved_by INTEGER,
  approved_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(approved_by) REFERENCES users(id)
);

-- Leave requests
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  leave_type TEXT NOT NULL CHECK (leave_type IN ('Sick', 'Vacation', 'Personal', 'Maternity', 'Other')),
  start_date INTEGER NOT NULL,
  end_date INTEGER NOT NULL,
  total_days INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
  approved_by INTEGER,
  approved_at INTEGER,
  rejection_reason TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(approved_by) REFERENCES users(id)
);

-- Payroll records
CREATE TABLE IF NOT EXISTS payroll_records (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  pay_period_start INTEGER NOT NULL,
  pay_period_end INTEGER NOT NULL,
  base_salary INTEGER DEFAULT 0,
  overtime_hours INTEGER DEFAULT 0,
  overtime_rate INTEGER DEFAULT 0,
  overtime_amount INTEGER DEFAULT 0,
  bonus INTEGER DEFAULT 0,
  deductions INTEGER DEFAULT 0,
  tax_amount INTEGER DEFAULT 0,
  net_pay INTEGER DEFAULT 0,
  payment_date INTEGER,
  payment_status TEXT DEFAULT 'Pending' CHECK (payment_status IN ('Pending', 'Paid', 'Cancelled')),
  notes TEXT,
  processed_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(processed_by) REFERENCES users(id)
);

-- Staff performance metrics
CREATE TABLE IF NOT EXISTS staff_performance (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  evaluation_date INTEGER NOT NULL,
  evaluator_id INTEGER,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comments TEXT,
  goals TEXT,
  achievements TEXT,
  areas_for_improvement TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(evaluator_id) REFERENCES users(id)
);

-- Indexes for staff tables
CREATE INDEX IF NOT EXISTS idx_staff_profiles_department ON staff_profiles(department);
CREATE INDEX IF NOT EXISTS idx_staff_profiles_manager ON staff_profiles(manager_id);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_user_date ON staff_shifts(user_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_date ON staff_shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance_records(user_id, date);
CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON leave_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_payroll_user_period ON payroll_records(user_id, pay_period_start, pay_period_end);
CREATE INDEX IF NOT EXISTS idx_performance_user_date ON staff_performance(user_id, evaluation_date);

-- Triggers for staff tables
CREATE TRIGGER IF NOT EXISTS update_staff_profiles_timestamp
  AFTER UPDATE ON staff_profiles
  BEGIN
    UPDATE staff_profiles SET updated_at = strftime('%s', 'now') * 1000 WHERE user_id = NEW.user_id;
  END;

CREATE TRIGGER IF NOT EXISTS update_staff_shifts_timestamp
  AFTER UPDATE ON staff_shifts
  BEGIN
    UPDATE staff_shifts SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_attendance_timestamp
  AFTER UPDATE ON attendance_records
  BEGIN
    UPDATE attendance_records SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_leave_requests_timestamp
  AFTER UPDATE ON leave_requests
  BEGIN
    UPDATE leave_requests SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_payroll_timestamp
  AFTER UPDATE ON payroll_records
  BEGIN
    UPDATE payroll_records SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_performance_timestamp
  AFTER UPDATE ON staff_performance
  BEGIN
    UPDATE staff_performance SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

-- Staff Management Tables

-- Extended staff profiles (extends users table)
CREATE TABLE IF NOT EXISTS staff_profiles (
  user_id INTEGER PRIMARY KEY,
  employee_id TEXT UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  emergency_contact TEXT,
  address TEXT,
  date_of_birth INTEGER,
  hire_date INTEGER NOT NULL,
  department TEXT DEFAULT 'Operations',
  position TEXT NOT NULL,
  hourly_rate INTEGER DEFAULT 0,
  monthly_salary INTEGER DEFAULT 0,
  employment_type TEXT DEFAULT 'Full-time' CHECK (employment_type IN ('Full-time', 'Part-time', 'Contract')),
  manager_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(manager_id) REFERENCES users(id)
);

-- Staff shifts and scheduling
CREATE TABLE IF NOT EXISTS staff_shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  shift_date INTEGER NOT NULL,
  start_time TEXT NOT NULL, -- HH:MM format
  end_time TEXT NOT NULL, -- HH:MM format
  break_duration INTEGER DEFAULT 30, -- minutes
  shift_type TEXT DEFAULT 'Regular' CHECK (shift_type IN ('Regular', 'Overtime', 'Holiday', 'Training')),
  notes TEXT,
  created_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

-- Attendance tracking
CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  date INTEGER NOT NULL,
  check_in_time INTEGER,
  check_out_time INTEGER,
  break_start_time INTEGER,
  break_end_time INTEGER,
  total_hours REAL DEFAULT 0,
  overtime_hours REAL DEFAULT 0,
  status TEXT DEFAULT 'Present' CHECK (status IN ('Present', 'Absent', 'Late', 'Half-day', 'Leave')),
  leave_type TEXT CHECK (leave_type IN ('Sick', 'Vacation', 'Personal', 'Maternity', 'Other')),
  notes TEXT,
  approved_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(approved_by) REFERENCES users(id)
);

-- Leave management
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  leave_type TEXT NOT NULL CHECK (leave_type IN ('Sick', 'Vacation', 'Personal', 'Maternity', 'Other')),
  start_date INTEGER NOT NULL,
  end_date INTEGER NOT NULL,
  total_days INTEGER NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
  approved_by INTEGER,
  approved_at INTEGER,
  rejection_reason TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(approved_by) REFERENCES users(id)
);

-- Payroll records
CREATE TABLE IF NOT EXISTS payroll_records (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  pay_period_start INTEGER NOT NULL,
  pay_period_end INTEGER NOT NULL,
  base_salary INTEGER NOT NULL,
  overtime_pay INTEGER DEFAULT 0,
  bonus INTEGER DEFAULT 0,
  deductions INTEGER DEFAULT 0,
  tax_deductions INTEGER DEFAULT 0,
  net_pay INTEGER NOT NULL,
  payment_date INTEGER,
  payment_method TEXT,
  status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending', 'Processed', 'Paid')),
  notes TEXT,
  processed_by INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(processed_by) REFERENCES users(id)
);

-- Performance reviews
CREATE TABLE IF NOT EXISTS performance_reviews (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  review_date INTEGER NOT NULL,
  review_period_start INTEGER NOT NULL,
  review_period_end INTEGER NOT NULL,
  reviewer_id INTEGER NOT NULL,
  overall_rating INTEGER NOT NULL CHECK (overall_rating >= 1 AND overall_rating <= 5),
  performance_category TEXT NOT NULL CHECK (performance_category IN ('Excellent', 'Good', 'Satisfactory', 'Needs Improvement', 'Poor')),
  achievements TEXT,
  areas_for_improvement TEXT,
  goals TEXT,
  comments TEXT,
  next_review_date INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(reviewer_id) REFERENCES users(id)
);

-- Indexes for staff management
CREATE INDEX IF NOT EXISTS idx_staff_profiles_active ON staff_profiles(is_active);
CREATE INDEX IF NOT EXISTS idx_staff_profiles_department ON staff_profiles(department);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_user_date ON staff_shifts(user_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_date ON staff_shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance_records(user_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(date);
CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON leave_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_payroll_user_period ON payroll_records(user_id, pay_period_start, pay_period_end);
CREATE INDEX IF NOT EXISTS idx_performance_user ON performance_reviews(user_id);

-- Triggers for staff management timestamps
CREATE TRIGGER IF NOT EXISTS update_staff_profiles_timestamp
  AFTER UPDATE ON staff_profiles
  BEGIN
    UPDATE staff_profiles SET updated_at = strftime('%s', 'now') * 1000 WHERE user_id = NEW.user_id;
  END;

CREATE TRIGGER IF NOT EXISTS update_staff_shifts_timestamp
  AFTER UPDATE ON staff_shifts
  BEGIN
    UPDATE staff_shifts SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_attendance_timestamp
  AFTER UPDATE ON attendance_records
  BEGIN
    UPDATE attendance_records SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_leave_requests_timestamp
  AFTER UPDATE ON leave_requests
  BEGIN
    UPDATE leave_requests SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_payroll_timestamp
  AFTER UPDATE ON payroll_records
  BEGIN
    UPDATE payroll_records SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_performance_timestamp
  AFTER UPDATE ON performance_reviews
  BEGIN
    UPDATE performance_reviews SET updated_at = strftime('%s', 'now') * 1000 WHERE id = NEW.id;
  END;