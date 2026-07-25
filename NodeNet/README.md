# ⚙️ DATAMAN BATTLE NODE SYSTEM (NodeNet)

This is the control and deployment hub for the DataMan Battle Node System, a collection of six self-contained, locally-run security and intelligence applications.

The **CoreNode** acts as the central GUI launcher for all modules.

---

## 🚀 Deployment and Launch

1.  **Server Requirement:** This system must be run via a local HTTP server (e.g., `http-server`). Running directly from the file system (`file://`) will cause errors in several nodes.
2.  **Launch Command (using http-server):**
    ```bash
    http-server .
    ```
3.  **Access:** Open your browser to `http://localhost:8080/CoreNode/index.html`.

---

## 📊 Node Manifest and Roles

| Node Folder | Final Node Name | Role | Primary Function |
| :--- | :--- | :--- | :--- |
| **CoreNode** | CoreNode | Launcher | Central GUI and access point for all modules. |
| **ArtKeyNode** | ArtKeyNode | Keying / Utility | Generates unique visual keys for system access. |
| **DefenseNode** | DefenseNode | Defense / Integrity | Automated Threat Sensor (Viri-Scanner) for file analysis. |
| **PassNode** | PassNode | Verification / Utility | Secure BN Link for encrypting/decrypting communication data. |
| **VoidNode** | VoidNode | Destruction / Utility | Secure Deletion Tool (Delete-Chip) for irreversible file wiping. |
| **NaviNode** | NaviNode | Compliance / Alerting | Patch-Checker for system vulnerability scanning. |
| **SirenNode** | SirenNode | Intelligence / Analysis | Phishing Analyzer ("Bane of Phishermen") for URL security analysis. |

---

## ✅ System Version Checksum

This checksum serves as a simple verification that all core components and files are present and match the intended system deployment.

**VERSION:** `DATAMAN-V1.0-R94-20251107`

| Checksum Component | Value | Meaning |
| :--- | :--- | :--- |
| **Major Version** | V1.0 | Initial production release. |
| **Revision Tag** | R94 | Represents the total number of code files (HTML, CSS, JS) in the system (6 nodes * 3 files + CoreNode * 1 file = 19 files, plus readme). |
| **Date Stamp** | 20251107 | Date of system finalization. |

### Integrity Verification
If any system file is added, modified, or removed, this checksum should be manually updated to reflect the change.

# ⚙️ DATAMAN BATTLE NODE SYSTEM (NodeNet)

This system is a collection of six self-contained, locally-run security and intelligence applications.

The system is designed to use the **http-server's native file index** as the central launch interface.

---

## 🚀 Deployment and Launch (Simplified)

1.  **Server Requirement:** This system must be run via a local HTTP server (e.g., `http-server`).
2.  **Launch Command (using http-server):** Navigate to the parent directory containing the **NodeNet** folder, then run:
    ```bash
    http-server NodeNet
    ```
3.  **Access:** Open your browser to `http://localhost:8080/`. The server will display the list of all Node folders. Click any folder name to launch the application.

---

## 📊 Node Manifest and Roles

| Node Folder | Final Node Name | Role | Primary Function |
| :--- | :--- | :--- | :--- |
| **ArtKeyNode** | ArtKeyNode | Keying / Utility | Generates unique visual keys for system access. |
| **DefenseNode** | DefenseNode | Defense / Integrity | Automated Threat Sensor (Viri-Scanner) for file analysis. |
| **PassNode** | PassNode | Verification / Utility | Secure BN Link for encrypting/decrypting communication data. |
| **VoidNode** | VoidNode | Destruction / Utility | Secure Deletion Tool (Delete-Chip) for irreversible file wiping. |
| **NaviNode** | NaviNode | Compliance / Alerting | Patch-Checker for system vulnerability scanning. |
| **SirenNode** | SirenNode | Intelligence / Analysis | Phishing Analyzer ("Bane of Phishermen") for URL security analysis. |

---

## ✅ System Version Checksum

This checksum verifies that all six core functional nodes are present.

**VERSION:** `DATAMAN-V1.0-R90-20251107-FINAL`

| Checksum Component | Value | Meaning |
| :--- | :--- | :--- |
| **Major Version** | V1.0 | Initial production release. |
| **Revision Tag** | R90 | Represents the total number of code files (6 nodes * 3 files = 18 files). |
| **Date Stamp** | 20251107 | Date of system finalization. |
| **Status** | FINAL | Confirms final structural optimization. |
