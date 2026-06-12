/**
 * Creates teacher import Excel files for bulk import testing.
 * Run with: node create-teacher-import.js
 */
const ExcelJS = require('exceljs');
const path = require('path');
const os = require('os');

async function createTeacherImportFile(filename, teachers) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Teachers');

  // Header row matching the template format
  const headerRow = ws.addRow(['name', 'email', 'phone', 'assignments']);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };

  // Data rows
  for (const t of teachers) {
    ws.addRow([t.name, t.email, t.phone, t.assignments]);
  }

  ws.columns = [
    { width: 25 },
    { width: 35 },
    { width: 15 },
    { width: 60 }
  ];

  const outputPath = path.join(os.homedir(), 'Desktop', filename);
  await wb.xlsx.writeFile(outputPath);
  console.log(`Created: ${outputPath}`);
  return outputPath;
}

async function main() {
  // English medium bulk import (6 teachers)
  const englishTeachers = [
    {
      name: 'Arvind Trivedi',
      email: 'arvind.demo@eduvo.com',
      phone: '9876543201',
      assignments: '9A-Hindi, 9B-Hindi, 10A-Hindi, 10B-Hindi, 12A-Hindi, 12B-Hindi'
    },
    {
      name: 'Priya Desai',
      email: 'priya.demo@eduvo.com',
      phone: '9876543202',
      assignments: '9A-English, 9B-English, 10A-English, 10B-English, 12A-English, 12B-English'
    },
    {
      name: 'Kiran Mehta',
      email: 'kiran.demo@eduvo.com',
      phone: '9876543203',
      assignments: '9A-Social Science, 9B-Social Science, 10A-Social Science, 10B-Social Science'
    },
    {
      name: 'Nilesh Solanki',
      email: 'nilesh.demo@eduvo.com',
      phone: '9876543204',
      assignments: '10A-Computer, 10B-Computer, 12A-Computer, 12B-Computer'
    },
    {
      name: 'Hetal Bhatt',
      email: 'hetal.demo@eduvo.com',
      phone: '9876543205',
      assignments: '9A-Sanskrit, 9B-Sanskrit, 10A-Sanskrit, 10B-Sanskrit, 12A-Sanskrit, 12B-Sanskrit'
    },
    {
      name: 'Deepak Sharma',
      email: 'deepak.demo@eduvo.com',
      phone: '9876543206',
      assignments: '10B-Maths, 12A-Maths, 12B-Maths'
    }
  ];

  await createTeacherImportFile('english_teachers_import.xlsx', englishTeachers);

  // Gujarati medium bulk import (6 teachers)
  const gujaratiTeachers = [
    {
      name: 'Dinesh Trivedi',
      email: 'dinesh.gu@eduvo.com',
      phone: '9876543211',
      assignments: '9A-Hindi, 9B-Hindi, 10A-Hindi, 10B-Hindi, 12A-Hindi, 12B-Hindi'
    },
    {
      name: 'Ekta Desai',
      email: 'ekta.gu@eduvo.com',
      phone: '9876543212',
      assignments: '9A-English, 9B-English, 10A-English, 10B-English, 12A-English, 12B-English'
    },
    {
      name: 'Falgun Mehta',
      email: 'falgun.gu@eduvo.com',
      phone: '9876543213',
      assignments: '9A-Social Science, 9B-Social Science, 10A-Social Science, 10B-Social Science'
    },
    {
      name: 'Girish Solanki',
      email: 'girish.gu@eduvo.com',
      phone: '9876543214',
      assignments: '10A-Computer, 10B-Computer, 12A-Computer, 12B-Computer'
    },
    {
      name: 'Hansa Bhatt',
      email: 'hansa.gu@eduvo.com',
      phone: '9876543215',
      assignments: '9A-Sanskrit, 9B-Sanskrit, 10A-Sanskrit, 10B-Sanskrit, 12A-Sanskrit, 12B-Sanskrit'
    },
    {
      name: 'Jagdish Rao',
      email: 'jagdish.gu@eduvo.com',
      phone: '9876543216',
      assignments: '10B-Maths, 12A-Maths, 12B-Maths'
    }
  ];

  await createTeacherImportFile('gujarati_teachers_import.xlsx', gujaratiTeachers);

  console.log('Both import files created successfully!');
}

main().catch(console.error);
