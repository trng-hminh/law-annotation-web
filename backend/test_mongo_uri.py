"""Test MongoDB Atlas connection (không cần sửa file này).
Cách dùng:
    MONGODB_URI="mongodb+srv://user:pass@host.mongodb.net/..." python test_mongo_uri.py
"""
import os
import sys
import certifi
from pymongo import MongoClient

uri = os.environ.get("MONGODB_URI", "").strip()
if not uri:
    print("Thiếu MONGODB_URI. Chạy:")
    print('  MONGODB_URI="mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/..." python test_mongo_uri.py')
    sys.exit(1)

print("Đang kết nối... (certifi:", certifi.where(), ")")
try:
    client = MongoClient(uri, serverSelectionTimeoutMS=8000, tlsCAFile=certifi.where())
    client.admin.command("ping")
    print("AUTH OK — KẾT NỐI THÀNH CÔNG. Chuỗi URI hợp lệ.")
except Exception as e:
    msg = str(e)
    if "CERTIFICATE_VERIFY_FAILED" in msg:
        print("LỖI SSL: certifi chưa được dùng. Cách sửa macOS:")
        print("  /Applications/Python 3.13/Install Certificates.command")
        print("hoặc chạy kèm:  SSL_CERT_FILE=\"$(python -m certifi)\" python test_mongo_uri.py")
    elif "Authentication failed" in msg or "bad auth" in msg.lower() or "auth" in msg.lower():
        print("LỖI AUTH: hostname + SSL OK, nhưng SAI user/password (hoặc user ở project khác).")
        print("-> Vào Atlas: Security -> Database Access, kiểm tra user thuộc đúng project của cluster.")
    elif "NXDOMAIN" in msg or "SRV" in msg or "getaddrinfo" in msg.lower():
        print("LỖI HOSTNAME: không tìm thấy cluster. Lấy lại URI chuẩn từ Connect -> Drivers.")
    else:
        print("Lỗi khác:", msg[:300])
